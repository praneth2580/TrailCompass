import type {
  CalculatedRoute,
  Coordinate,
  RouteRequestOptions,
  RoutingAdapter,
} from './routing-adapter';
import {
  offlineGraphEngine,
  type RoutingNetworkMeta,
} from './graph-engine';
import { valhallaOfflineAdapter } from './valhalla-adapter';
import { loadOsmNetworkForRoute } from './osm-network-loader';
import {
  expandRouteChain,
  needsRouteChunking,
  type RouteChainPoint,
} from './route-chunking';
import {
  idleProgress,
  type RoutingProgress,
  type RoutingProgressListener,
} from './routing-progress';
import type { RoutingProfileId } from './routing-profiles';

export const DEMO_NETWORK_URL = '/assets/routing/demo-network.geojson';
export const VALHALLA_TILES_URL = '/assets/routing/valhalla-tiles.tar';

export type OfflineEngineKind = 'valhalla' | 'graph' | 'none';

export interface OfflineEngineStatus {
  kind: OfflineEngineKind;
  ready: boolean;
  label: string;
  attribution?: string;
  network?: RoutingNetworkMeta;
  message: string;
}

/**
 * Offline-first RoutingAdapter.
 * Prefers Valhalla WASM when tiles are present; otherwise loads OSM road
 * geometry for the route corridor and runs local A* (oneway-aware).
 * Does not call an online turn-by-turn routing API.
 */
export class OfflineRoutingAdapter implements RoutingAdapter {
  private initialized = false;
  private status: OfflineEngineStatus = {
    kind: 'none',
    ready: false,
    label: 'Offline routing',
    message: 'Routing engine not initialized',
  };
  private listeners = new Set<(status: OfflineEngineStatus) => void>();
  private progressListeners = new Set<RoutingProgressListener>();

  subscribe(listener: (status: OfflineEngineStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  subscribeProgress(listener: RoutingProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  getStatus(): OfflineEngineStatus {
    return this.status;
  }

  async initialize(): Promise<OfflineEngineStatus> {
    if (this.initialized && this.status.ready) {
      return this.status;
    }

    const hasValhallaTiles = await resourceExists(VALHALLA_TILES_URL);
    if (hasValhallaTiles) {
      const ok = await valhallaOfflineAdapter.tryInitialize(VALHALLA_TILES_URL);
      if (ok) {
        this.initialized = true;
        this.setStatus({
          kind: 'valhalla',
          ready: true,
          label: 'Valhalla WASM',
          message: 'Offline Valhalla engine ready',
          attribution: 'Valhalla · © OpenStreetMap contributors (ODbL)',
        });
        return this.status;
      }
    }

    // Graph engine starts empty; roads are loaded per route from OSM extracts
    // (and optionally the bundled demo network if already covering the points).
    try {
      await offlineGraphEngine.loadFromUrl(DEMO_NETWORK_URL);
    } catch {
      // Demo package optional — live OSM extracts still work.
    }

    this.initialized = true;
    this.setStatus({
      kind: 'graph',
      ready: true,
      label: 'OSM road graph',
      network: offlineGraphEngine.isReady()
        ? offlineGraphEngine.getMeta()
        : undefined,
      attribution: '© OpenStreetMap contributors (ODbL)',
      message:
        'Ready — loads connecting roads for each plan (one-way aware A*)',
    });
    return this.status;
  }

  async calculateRoute(
    start: Coordinate,
    end: Coordinate,
    waypointsOrOptions?: Coordinate[] | RouteRequestOptions,
  ): Promise<CalculatedRoute> {
    const routes = await this.calculateRoutes(
      start,
      end,
      normalizeOptions(waypointsOrOptions),
    );
    return routes[0]!;
  }

  async calculateRoutes(
    start: Coordinate,
    end: Coordinate,
    options: RouteRequestOptions = {},
  ): Promise<CalculatedRoute[]> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.status.ready) {
      throw new Error(this.status.message || 'Routing engine pending');
    }

    const waypoints = options.waypoints ?? [];
    const profile: RoutingProfileId = options.profile ?? 'fastest';
    const alternatives = options.alternatives ?? 3;

    try {
      if (this.status.kind === 'valhalla') {
        this.emitProgress({
          phase: 'calculating',
          label: 'Calculating route…',
          percent: null,
        });
        const route = await valhallaOfflineAdapter.calculateRoute(
          start,
          end,
          waypoints,
        );
        route.profile = profile;
        route.label = 'Best match';
        route.id = `valhalla-${profile}`;
        this.emitProgress({
          phase: 'done',
          label: 'Route ready',
          percent: 100,
        });
        return [route];
      }

      // Long trips + user waypoints: chain short legs (download + A* per hop).
      if (needsRouteChunking(start, end, waypoints)) {
        const chain = expandRouteChain(start, end, waypoints);
        const merged = await this.calculateChainedRoute(chain, profile);
        this.emitProgress({
          phase: 'done',
          label:
            chain.length > 2
              ? `Route ready · ${chain.length - 1} legs`
              : 'Route ready',
          percent: 100,
        });
        return [merged];
      }

      await this.ensureRoadGraph(start, end);

      this.emitProgress({
        phase: 'calculating',
        label: 'Finding best & alternative roads…',
        percent: null,
      });

      const routes = offlineGraphEngine.calculateRoutes(start, end, {
        profile,
        alternatives,
      });
      this.emitProgress({
        phase: 'done',
        label:
          routes.length > 1
            ? `${routes.length} road options ready`
            : 'Route ready',
        percent: 100,
      });
      return routes;
    } catch (e) {
      this.emitProgress({
        phase: 'error',
        label: e instanceof Error ? e.message : 'Routing failed',
        percent: null,
      });
      throw e;
    } finally {
      window.setTimeout(() => this.emitProgress(idleProgress()), 400);
    }
  }

  /**
   * Route a chain of points leg-by-leg. Each hop downloads only its corridor.
   * Synthetic vias are snapped onto the nearest loaded road so geodesic
   * midpoints in empty fields still connect.
   */
  private async calculateChainedRoute(
    chain: RouteChainPoint[],
    profile: RoutingProfileId,
  ): Promise<CalculatedRoute> {
    if (chain.length < 2) {
      throw new Error('Route chain needs at least start and end');
    }

    const legs: CalculatedRoute[] = [];
    let cursor = chain[0]!.coordinate;
    const legCount = chain.length - 1;

    for (let i = 1; i < chain.length; i++) {
      const stop = chain[i]!;
      const legIndex = i;
      this.emitProgress({
        phase: 'downloading-roads',
        label: `Leg ${legIndex} of ${legCount} — loading roads…`,
        percent:
          legCount > 1
            ? Math.round(((legIndex - 1) / legCount) * 100)
            : null,
      });

      await this.ensureRoadGraph(cursor, stop.coordinate, {
        progressLabel: `Leg ${legIndex} of ${legCount} — loading roads…`,
        requireCoverage: !stop.synthetic,
      });

      let target = stop.coordinate;
      if (stop.synthetic) {
        const snapped = offlineGraphEngine.nearestRoadCoordinate(target, 12_000);
        if (!snapped) {
          throw new Error(
            `Could not find roads near via point ${legIndex} of ${legCount}`,
          );
        }
        target = snapped;
      } else if (!offlineGraphEngine.coversPoints(cursor, target)) {
        throw new Error(
          `Could not snap onto roads for leg ${legIndex} of ${legCount} — try a pin closer to a street`,
        );
      }

      this.emitProgress({
        phase: 'calculating',
        label: `Leg ${legIndex} of ${legCount} — calculating…`,
        percent:
          legCount > 1
            ? Math.round(((legIndex - 0.5) / legCount) * 100)
            : null,
      });

      legs.push(
        offlineGraphEngine.calculateRoute(cursor, target, { profile }),
      );
      cursor = target;
    }

    const merged = mergeRoutes(legs);
    merged.profile = profile;
    merged.label =
      legs.length > 1 ? `Best match · ${legs.length} legs` : 'Best match';
    merged.id = `graph-chunked-${legs.length}`;
    return merged;
  }

  private async ensureRoadGraph(
    start: Coordinate,
    end: Coordinate,
    options: {
      progressLabel?: string;
      waypoints?: Coordinate[];
      /** When false, allow end to be snapped later (synthetic vias). */
      requireCoverage?: boolean;
    } = {},
  ): Promise<void> {
    const requireCoverage = options.requireCoverage !== false;

    if (offlineGraphEngine.coversPoints(start, end)) {
      this.emitProgress({
        phase: 'checking-cache',
        label: 'Roads already loaded',
        percent: 100,
      });
      return;
    }

    this.setStatus({
      ...this.status,
      kind: 'graph',
      ready: true,
      message: options.progressLabel ?? 'Downloading connecting roads…',
    });

    const collection = await loadOsmNetworkForRoute(
      start,
      end,
      options.waypoints ?? [],
      (progress) =>
        this.emitProgress({
          ...progress,
          label: options.progressLabel ?? progress.label,
        }),
    );
    offlineGraphEngine.loadFeatureCollection(collection);

    this.setStatus({
      kind: 'graph',
      ready: true,
      label: collection.region?.label ?? 'OSM road graph',
      network: offlineGraphEngine.getMeta(),
      attribution: collection.attribution,
      message: `Routing on ${collection.features.length} OSM ways`,
    });

    if (requireCoverage && !offlineGraphEngine.coversPoints(start, end)) {
      throw new Error(
        'Could not snap onto downloaded roads — try a pin closer to a street',
      );
    }
  }

  private setStatus(status: OfflineEngineStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  private emitProgress(progress: RoutingProgress): void {
    for (const listener of this.progressListeners) listener(progress);
  }
}

function normalizeOptions(
  waypointsOrOptions?: Coordinate[] | RouteRequestOptions,
): RouteRequestOptions {
  if (!waypointsOrOptions) return {};
  if (Array.isArray(waypointsOrOptions)) {
    return { waypoints: waypointsOrOptions };
  }
  return waypointsOrOptions;
}

function mergeRoutes(legs: CalculatedRoute[]): CalculatedRoute {
  if (legs.length === 0) {
    throw new Error('No route legs to merge');
  }
  if (legs.length === 1) return legs[0]!;

  const coordinates: Coordinate[] = [...legs[0]!.coordinates];
  const instructions = [...legs[0]!.instructions];
  let distanceMeters = legs[0]!.distanceMeters;
  let durationSeconds = legs[0]!.durationSeconds;

  for (let i = 1; i < legs.length; i++) {
    const leg = legs[i]!;
    const slice =
      coordinates.length > 0 &&
      leg.coordinates[0] &&
      coordinates[coordinates.length - 1]![0] === leg.coordinates[0][0] &&
      coordinates[coordinates.length - 1]![1] === leg.coordinates[0][1]
        ? leg.coordinates.slice(1)
        : leg.coordinates;
    coordinates.push(...slice);
    instructions.push(...leg.instructions);
    distanceMeters += leg.distanceMeters;
    durationSeconds += leg.durationSeconds;
  }

  return { coordinates, distanceMeters, durationSeconds, instructions };
}

async function resourceExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-63' },
    });
    if (!(response.ok || response.status === 206)) return false;
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (type.includes('text/html')) return false;
    return true;
  } catch {
    return false;
  }
}

export const offlineRoutingAdapter = new OfflineRoutingAdapter();
