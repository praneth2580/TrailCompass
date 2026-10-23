import type {
  CalculatedRoute,
  Coordinate,
  RouteRequestOptions,
  RoutingAdapter,
} from './routing-adapter';
import {
  NoRoadPathError,
  offlineGraphEngine,
  type NetworkFeatureCollection,
  type RouteOptions,
  type RoutingNetworkMeta,
} from './graph-engine';
import { valhallaOfflineAdapter } from './valhalla-adapter';
import {
  clipNetwork,
  loadLocalArea,
  loadOsmNetworkForRoute,
  mergeNetworks,
  paddedBbox,
} from './osm-network-loader';
import {
  backboneRadiusMeters,
  loadBackboneNetwork,
} from './backbone-loader';
import { mergeRoutes } from './route-merge';
import {
  ROUTE_CHUNK_MAX_M,
  needsRouteChunking,
  splitPolyline,
} from './route-chunking';
import { haversineMeters, polylineLengthMeters } from './geo';
import { buildManeuversFromPath } from './maneuver-builder';
import {
  idleProgress,
  type RoutingProgress,
  type RoutingProgressListener,
} from './routing-progress';
import type { RoutingProfileId } from './routing-profiles';
import { isAbortError, throwIfAborted } from './abort';

export const DEMO_NETWORK_URL = '/assets/routing/demo-network.geojson';
export const VALHALLA_TILES_URL = '/assets/routing/valhalla-tiles.tar';

/** Detail refinement leg along the backbone path. */
const REFINE_LEG_M = 50_000;
/** Full-detail streets around each trip endpoint for the backbone pass. */
const LOCAL_AREA_M = 6_000;
/** Secondary / tertiary roads around each endpoint, out to the highways. */
const CONNECTOR_AREA_M = 20_000;
/** Major roads around the refined leg, merged in so gaps still connect. */
const REFINE_BACKBONE_PAD_M = 5_000;

export type OfflineEngineKind = 'valhalla' | 'graph' | 'none';

interface BackbonePass {
  /** Major roads + local streets the backbone legs were routed on. */
  network: NetworkFeatureCollection;
  /** One route per user leg (start → stop → … → end). */
  legs: CalculatedRoute[];
}

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

      const routeOptions: RouteOptions = {
        profile,
        allowExpressways: options.allowExpressways ?? false,
      };
      const anchors = [start, ...waypoints, end];

      // Short trip: one download, a few alternatives.
      if (!needsRouteChunking(start, end, waypoints)) {
        try {
          const routes = await this.calculateDirectRoutes(
            start,
            end,
            { ...routeOptions, alternatives },
            signal,
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
          // The connecting road may leave the small download box.
          if (!(e instanceof NoRoadPathError)) throw e;
        }
      } else if (everyHopWithin(anchors, ROUTE_CHUNK_MAX_M)) {
        // Stops close together: route stop to stop.
        try {
          const merged = await this.calculateChainedRoute(
            anchors,
            routeOptions,
            signal,
          );
          this.emitProgress({
            phase: 'done',
            label:
              anchors.length > 2
                ? `Route ready · ${anchors.length - 1} legs`
                : 'Route ready',
            percent: 100,
          });
          return [merged];
        } catch (e) {
          if (!(e instanceof NoRoadPathError)) throw e;
        }
      }

      // Long trip, or the corridor didn't connect: find the real road
      // corridor on major roads first, then refine along it.
      const merged = await this.calculateTwoPassRoute(
        anchors,
        routeOptions,
        signal,
      );
      this.emitProgress({
        phase: 'done',
        label: 'Route ready',
        percent: 100,
      });
      return [merged];
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

  private async calculateDirectRoutes(
    start: Coordinate,
    end: Coordinate,
    routeOptions: RouteOptions,
    signal?: AbortSignal,
  ): Promise<CalculatedRoute[]> {
    await this.ensureRoadGraph(start, end, {
      requireCoverage: false,
      signal,
    });

    this.emitProgress({
      phase: 'calculating',
      label: 'Finding best & alternative roads…',
      percent: null,
    });

    const snapped = this.snapRoutingEndpoints(start, end, routeOptions);
    return offlineGraphEngine.calculateRoutes(
      snapped.start,
      snapped.end,
      routeOptions,
    );
  }

  /**
   * Route stop to stop when every hop is short. Each hop downloads only its
   * corridor. The next hop's Overpass request is started before A* on the
   * current hop, so the mirror can work while the search runs. Routing stays
   * in order: hop N+1 begins at the snapped end of hop N.
   */
  private async calculateChainedRoute(
    chain: Coordinate[],
    routeOptions: RouteOptions,
    signal?: AbortSignal,
  ): Promise<CalculatedRoute> {
    throwIfAborted(signal);
    if (chain.length < 2) {
      throw new Error('Route chain needs at least start and end');
    }

    const legs: CalculatedRoute[] = [];
    let cursor = chain[0]!;
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

    preload(1, chain[0]!, chain[1]!, true);
    if (legCount > 1) {
      preload(2, chain[1]!, chain[2]!, false);
    }

    for (let i = 1; i < chain.length; i++) {
      throwIfAborted(signal);
      const stop = chain[i]!;
      const legIndex = i;
      const label = `Leg ${legIndex} of ${legCount} — loading roads…`;

      if (i + 1 <= legCount) {
        preload(i + 1, chain[i]!, chain[i + 1]!, false);
      }

      this.emitProgress({
        phase: 'downloading-roads',
        label,
        percent:
          legCount > 1
            ? Math.round(((legIndex - 1) / legCount) * 100)
            : null,
      });

      const prefetchFrom = chain[i - 1]!;
      const prefetchMatchesCursor =
        prefetchFrom[0] === cursor[0] && prefetchFrom[1] === cursor[1];

      await this.loadPrefetchedCorridor(cursor, stop, {
        signal,
        progressLabel: label,
        prefetched: downloads.get(legIndex),
        refetchOnMiss: !prefetchMatchesCursor,
        maxSnapMeters: 2_500,
      });

      const snapped = this.snapRoutingEndpoints(cursor, stop, routeOptions);

      this.emitProgress({
        phase: 'calculating',
        label: `Leg ${legIndex} of ${legCount} — calculating…`,
        percent:
          legCount > 1
            ? Math.round(((legIndex - 0.5) / legCount) * 100)
            : null,
      });

      legs.push(
        offlineGraphEngine.calculateRoute(
          snapped.start,
          snapped.end,
          routeOptions,
        ),
      );
      cursor = snapped.end;
    }

    const merged = mergeRoutes(legs);
    merged.profile = routeOptions.profile;
    merged.label =
      legs.length > 1 ? `Best match · ${legs.length} legs` : 'Best match';
    merged.id = `graph-chunked-${legs.length}`;
    return merged;
  }

  /**
   * Long trips. Pass 1 routes on major roads (cached tiles around the trip)
   * plus local streets at each stop, which finds where the road really goes
   * — inland highways, bridges, ghats — instead of the straight line.
   * Pass 2 downloads full detail along that path, leg by leg, and re-routes
   * each leg with the backbone merged in. A leg that still fails keeps its
   * backbone path, so once pass 1 succeeds the trip always gets a route.
   */
  private async calculateTwoPassRoute(
    anchors: Coordinate[],
    routeOptions: RouteOptions,
    signal?: AbortSignal,
  ): Promise<CalculatedRoute> {
    let radius = backboneRadiusMeters(polylineLengthMeters(anchors));
    let backbone: BackbonePass | null = null;
    for (let attempt = 0; attempt < 2 && !backbone; attempt++) {
      try {
        backbone = await this.routeOnBackbone(
          anchors,
          radius,
          routeOptions,
          signal,
        );
      } catch (e) {
        if (!(e instanceof NoRoadPathError)) throw e;
        // The road may detour further than expected: widen once.
        radius *= 2;
      }
    }
    if (!backbone) {
      throw new NoRoadPathError(
        routeOptions.allowExpressways
          ? 'No road connection found between these places'
          : 'No road connection found without expressways — try allowing them',
      );
    }

    const slices = backbone.legs.flatMap((leg) => {
      const legMeters = Math.max(1, polylineLengthMeters(leg.coordinates));
      return splitPolyline(leg.coordinates, REFINE_LEG_M).map((guide) => ({
        guide,
        seconds:
          (polylineLengthMeters(guide) / legMeters) * leg.durationSeconds,
      }));
    });

    const downloads = new Map<number, Promise<NetworkFeatureCollection>>();
    const preload = (index: number) => {
      const slice = slices[index];
      if (!slice || downloads.has(index)) return;
      const guide = slice.guide;
      const task = loadOsmNetworkForRoute(
        guide[0]!,
        guide[guide.length - 1]!,
        [],
        undefined,
        signal,
        { guide },
      );
      void task.catch(() => {});
      downloads.set(index, task);
    };
    preload(0);
    preload(1);

    const legs: CalculatedRoute[] = [];
    for (let k = 0; k < slices.length; k++) {
      throwIfAborted(signal);
      preload(k + 1);
      const { guide, seconds } = slices[k]!;
      this.emitProgress({
        phase: 'downloading-roads',
        label: `Refining leg ${k + 1} of ${slices.length}…`,
        percent: Math.round((k / slices.length) * 100),
      });
      try {
        const detail = await downloads.get(k)!;
        throwIfAborted(signal);
        this.applyRoadCollection(
          mergeNetworks([
            clipNetwork(
              backbone.network,
              paddedBbox(guide, REFINE_BACKBONE_PAD_M),
            ),
            detail,
          ]),
        );
        const snapped = this.snapRoutingEndpoints(
          guide[0]!,
          guide[guide.length - 1]!,
          routeOptions,
        );
        legs.push(
          offlineGraphEngine.calculateRoute(
            snapped.start,
            snapped.end,
            routeOptions,
          ),
        );
      } catch (e) {
        if (isAbortError(e)) throw e;
        legs.push(pathAsRoute(guide, seconds));
      }
    }

    const merged = mergeRoutes(legs);
    merged.profile = routeOptions.profile;
    merged.label = 'Best match';
    merged.id = `graph-two-pass-${legs.length}`;
    return merged;
  }

  /** Pass 1: one A* per user leg on major roads + local streets. */
  private async routeOnBackbone(
    anchors: Coordinate[],
    radiusMeters: number,
    routeOptions: RouteOptions,
    signal?: AbortSignal,
  ): Promise<BackbonePass> {
    const [backbone, ...locals] = await Promise.all([
      loadBackboneNetwork(
        anchors,
        radiusMeters,
        (progress) => this.emitProgress(progress),
        signal,
      ),
      ...anchors.map((point) =>
        loadLocalArea(point, LOCAL_AREA_M, CONNECTOR_AREA_M, undefined, signal),
      ),
    ]);
    throwIfAborted(signal);

    this.emitProgress({
      phase: 'building-graph',
      label: 'Building major-road graph…',
      percent: null,
    });
    const network = mergeNetworks([backbone!, ...locals]);
    this.applyRoadCollection(network);

    this.emitProgress({
      phase: 'calculating',
      label: 'Finding the main route…',
      percent: null,
    });
    const legs: CalculatedRoute[] = [];
    for (let i = 1; i < anchors.length; i++) {
      const snapped = this.snapRoutingEndpoints(
        anchors[i - 1]!,
        anchors[i]!,
        routeOptions,
      );
      legs.push(
        offlineGraphEngine.calculateRoute(
          snapped.start,
          snapped.end,
          routeOptions,
        ),
      );
    }
    return { network, legs };
  }

  /**
   * Pull start/end onto the loaded graph. Search pins and GPS can sit
   * slightly off the carriageway — allow up to `maxMeters`.
   */
  private snapRoutingEndpoints(
    start: Coordinate,
    end: Coordinate,
    routeOptions: RouteOptions,
    maxMeters = 2_500,
  ): { start: Coordinate; end: Coordinate } {
    const snapOptions = { allowExpressways: routeOptions.allowExpressways };
    const snappedStart = offlineGraphEngine.nearestRoadCoordinate(
      start,
      maxMeters,
      snapOptions,
    );
    const snappedEnd = offlineGraphEngine.nearestRoadCoordinate(
      end,
      maxMeters,
      snapOptions,
    );
    if (!snappedStart || !snappedEnd) {
      throw new NoRoadPathError(
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
        throw new NoRoadPathError(
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

/** A known road path as a route (fallback when detail routing fails). */
function pathAsRoute(path: Coordinate[], seconds: number): CalculatedRoute {
  return {
    coordinates: path,
    distanceMeters: polylineLengthMeters(path),
    durationSeconds: Math.max(1, Math.round(seconds)),
    instructions: buildManeuversFromPath(path),
  };
}

function everyHopWithin(points: Coordinate[], maxMeters: number): boolean {
  for (let i = 1; i < points.length; i++) {
    if (haversineMeters(points[i - 1]!, points[i]!) > maxMeters) return false;
  }
  return true;
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
