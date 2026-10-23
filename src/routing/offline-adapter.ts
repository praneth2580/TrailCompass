import type {
  CalculatedRoute,
  Coordinate,
  RouteRequestOptions,
  RoutingAdapter,
} from './routing-adapter';
import {
  offlineGraphEngine,
  type NetworkFeatureCollection,
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
import { isAbortError, throwIfAborted } from './abort';

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
  /** Bumps on each calculateRoutes so a stale job cannot clear a newer one's progress. */
  private jobEpoch = 0;

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
    const signal = options.signal;
    const epoch = ++this.jobEpoch;

    try {
      throwIfAborted(signal);
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
        throwIfAborted(signal);
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
        const merged = await this.calculateChainedRoute(chain, profile, signal);
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

      await this.ensureRoadGraph(start, end, {
        requireCoverage: false,
        signal,
      });

      this.emitProgress({
        phase: 'calculating',
        label: 'Finding best & alternative roads…',
        percent: null,
      });

      const snapped = this.snapRoutingEndpoints(start, end);
      const routes = offlineGraphEngine.calculateRoutes(
        snapped.start,
        snapped.end,
        {
          profile,
          alternatives,
        },
      );
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
      if (isAbortError(e)) throw e;
      this.emitProgress({
        phase: 'error',
        label: e instanceof Error ? e.message : 'Routing failed',
        percent: null,
      });
      throw e;
    } finally {
      const finishedEpoch = epoch;
      window.setTimeout(() => {
        if (this.jobEpoch === finishedEpoch) this.emitProgress(idleProgress());
      }, 400);
    }
  }

  /**
   * Route a chain of points leg-by-leg. Each hop downloads only its corridor.
   * The next hop's Overpass request is started before A* on the current hop,
   * so the mirror can work while the search runs. Routing stays in order:
   * hop N+1 begins at the snapped end of hop N.
   */
  private async calculateChainedRoute(
    chain: RouteChainPoint[],
    profile: RoutingProfileId,
    signal?: AbortSignal,
  ): Promise<CalculatedRoute> {
    throwIfAborted(signal);
    if (chain.length < 2) {
      throw new Error('Route chain needs at least start and end');
    }

    const legs: CalculatedRoute[] = [];
    let cursor = chain[0]!.coordinate;
    const legCount = chain.length - 1;
    const downloads = new Map<number, Promise<NetworkFeatureCollection>>();

    const preload = (
      legNumber: number,
      from: Coordinate,
      to: Coordinate,
      report: boolean,
    ) => {
      if (downloads.has(legNumber) || legNumber < 1 || legNumber > legCount) {
        return;
      }
      const label = `Leg ${legNumber} of ${legCount} — loading roads…`;
      const task = loadOsmNetworkForRoute(
        from,
        to,
        [],
        report
          ? (progress) =>
              this.emitProgress({
                ...progress,
                label,
              })
          : undefined,
        signal,
      );
      // The hop may be abandoned (already covered, or an earlier hop failed).
      // A handler here keeps that rejection from surfacing as unhandled.
      void task.catch(() => {});
      downloads.set(legNumber, task);
    };

    preload(1, chain[0]!.coordinate, chain[1]!.coordinate, true);
    if (legCount > 1) {
      preload(2, chain[1]!.coordinate, chain[2]!.coordinate, false);
    }

    for (let i = 1; i < chain.length; i++) {
      throwIfAborted(signal);
      const stop = chain[i]!;
      const legIndex = i;
      const maxSnap = stop.synthetic ? 12_000 : 2_500;
      const label = `Leg ${legIndex} of ${legCount} — loading roads…`;

      if (i + 1 <= legCount) {
        preload(i + 1, chain[i]!.coordinate, chain[i + 1]!.coordinate, false);
      }

      this.emitProgress({
        phase: 'downloading-roads',
        label,
        percent:
          legCount > 1
            ? Math.round(((legIndex - 1) / legCount) * 100)
            : null,
      });

      const prefetchFrom = chain[i - 1]!.coordinate;
      const prefetchMatchesCursor =
        prefetchFrom[0] === cursor[0] && prefetchFrom[1] === cursor[1];

      await this.loadPrefetchedCorridor(cursor, stop.coordinate, {
        signal,
        progressLabel: label,
        prefetched: downloads.get(legIndex),
        refetchOnMiss: !prefetchMatchesCursor,
        maxSnapMeters: maxSnap,
      });

      const snapped = this.snapRoutingEndpoints(
        cursor,
        stop.coordinate,
        maxSnap,
      );

      this.emitProgress({
        phase: 'calculating',
        label: `Leg ${legIndex} of ${legCount} — calculating…`,
        percent:
          legCount > 1
            ? Math.round(((legIndex - 0.5) / legCount) * 100)
            : null,
      });

      legs.push(
        offlineGraphEngine.calculateRoute(snapped.start, snapped.end, {
          profile,
        }),
      );
      cursor = snapped.end;
    }

    const merged = mergeRoutes(legs);
    merged.profile = profile;
    merged.label =
      legs.length > 1 ? `Best match · ${legs.length} legs` : 'Best match';
    merged.id = `graph-chunked-${legs.length}`;
    return merged;
  }

  /**
   * Pull start/end onto the loaded graph. Search pins and GPS can sit
   * slightly off the carriageway — allow up to `maxMeters`.
   */
  private snapRoutingEndpoints(
    start: Coordinate,
    end: Coordinate,
    maxMeters = 2_500,
  ): { start: Coordinate; end: Coordinate } {
    const snappedStart =
      offlineGraphEngine.nearestRoadCoordinate(start, maxMeters) ?? null;
    const snappedEnd =
      offlineGraphEngine.nearestRoadCoordinate(end, maxMeters) ?? null;
    if (!snappedStart || !snappedEnd) {
      throw new Error(
        'Could not snap onto downloaded roads — try a pin closer to a street, or pick the place on the map',
      );
    }
    return { start: snappedStart, end: snappedEnd };
  }

  /**
   * Load a corridor that may already be downloading. If the pack was fetched
   * along the geodesic and the snapped end of the previous hop sits outside
   * it, discard that pack and download from the snapped point.
   */
  private async loadPrefetchedCorridor(
    start: Coordinate,
    end: Coordinate,
    options: {
      signal?: AbortSignal;
      progressLabel: string;
      prefetched?: Promise<NetworkFeatureCollection>;
      refetchOnMiss: boolean;
      maxSnapMeters: number;
    },
  ): Promise<void> {
    throwIfAborted(options.signal);
    // 350m, same as a normal hop — a wide snap here would treat the previous
    // corridor as if it already reached the next town.
    if (offlineGraphEngine.coversPoints(start, end)) {
      this.emitProgress({
        phase: 'checking-cache',
        label: 'Using loaded roads',
        percent: 100,
      });
      return;
    }

    const onProgress = (progress: RoutingProgress) =>
      this.emitProgress({
        ...progress,
        label: options.progressLabel,
      });

    let collection = options.prefetched
      ? await options.prefetched
      : await loadOsmNetworkForRoute(start, end, [], onProgress, options.signal);
    throwIfAborted(options.signal);
    this.applyRoadCollection(collection);

    if (
      options.refetchOnMiss &&
      !this.corridorCovers(start, end, options.maxSnapMeters)
    ) {
      collection = await loadOsmNetworkForRoute(
        start,
        end,
        [],
        onProgress,
        options.signal,
      );
      this.applyRoadCollection(collection);
    }
  }

  private corridorCovers(
    start: Coordinate,
    end: Coordinate,
    maxMeters: number,
  ): boolean {
    return (
      offlineGraphEngine.nearestRoadCoordinate(start, maxMeters) != null &&
      offlineGraphEngine.nearestRoadCoordinate(end, maxMeters) != null
    );
  }

  private applyRoadCollection(collection: NetworkFeatureCollection): void {
    offlineGraphEngine.loadFeatureCollection(collection);
    this.setStatus({
      kind: 'graph',
      ready: true,
      label: collection.region?.label ?? 'OSM road graph',
      network: offlineGraphEngine.getMeta(),
      attribution: collection.attribution,
      message: `Routing on ${collection.features.length} OSM ways`,
    });
  }

  private async ensureRoadGraph(
    start: Coordinate,
    end: Coordinate,
    options: {
      progressLabel?: string;
      waypoints?: Coordinate[];
      /** When false, coverage is checked via snapRoutingEndpoints later. */
      requireCoverage?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const requireCoverage = options.requireCoverage !== false;
    throwIfAborted(options.signal);

    if (offlineGraphEngine.coversPoints(start, end)) {
      this.emitProgress({
        phase: 'checking-cache',
        label: 'Using loaded roads',
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
      options.signal,
    );
    this.applyRoadCollection(collection);

    if (requireCoverage && !offlineGraphEngine.coversPoints(start, end)) {
      const soft =
        offlineGraphEngine.nearestRoadCoordinate(start, 2_500) &&
        offlineGraphEngine.nearestRoadCoordinate(end, 2_500);
      if (!soft) {
        throw new Error(
          'Could not snap onto downloaded roads — try a pin closer to a street, or pick the place on the map',
        );
      }
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
