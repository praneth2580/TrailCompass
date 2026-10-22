import type {
  CalculatedRoute,
  Coordinate,
  RoutingAdapter,
} from './routing-adapter';
import {
  offlineGraphEngine,
  type RoutingNetworkMeta,
} from './graph-engine';
import { valhallaOfflineAdapter } from './valhalla-adapter';
import { loadOsmNetworkForRoute } from './osm-network-loader';

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

  subscribe(listener: (status: OfflineEngineStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
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
    waypoints?: Coordinate[],
  ): Promise<CalculatedRoute> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.status.ready) {
      throw new Error(
        this.status.message || 'Routing engine pending',
      );
    }

    if (this.status.kind === 'valhalla') {
      return valhallaOfflineAdapter.calculateRoute(start, end, waypoints);
    }

    await this.ensureRoadGraph(start, end, waypoints);

    if (waypoints && waypoints.length > 0) {
      const legs: CalculatedRoute[] = [];
      let cursor = start;
      const stops = [...waypoints, end];
      for (const stop of stops) {
        await this.ensureRoadGraph(cursor, stop);
        legs.push(offlineGraphEngine.calculateRoute(cursor, stop));
        cursor = stop;
      }
      return mergeRoutes(legs);
    }

    return offlineGraphEngine.calculateRoute(start, end);
  }

  private async ensureRoadGraph(
    start: Coordinate,
    end: Coordinate,
    waypoints: Coordinate[] = [],
  ): Promise<void> {
    if (offlineGraphEngine.coversPoints(start, end)) {
      return;
    }

    this.setStatus({
      ...this.status,
      kind: 'graph',
      ready: true,
      message: 'Downloading connecting roads…',
    });

    const collection = await loadOsmNetworkForRoute(start, end, waypoints);
    offlineGraphEngine.loadFeatureCollection(collection);

    this.setStatus({
      kind: 'graph',
      ready: true,
      label: collection.region?.label ?? 'OSM road graph',
      network: offlineGraphEngine.getMeta(),
      attribution: collection.attribution,
      message: `Routing on ${collection.features.length} OSM ways`,
    });

    if (!offlineGraphEngine.coversPoints(start, end)) {
      throw new Error(
        'Could not snap onto downloaded roads — try a pin closer to a street',
      );
    }
  }

  private setStatus(status: OfflineEngineStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
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
