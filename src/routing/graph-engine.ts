import type { CalculatedRoute, Coordinate } from './routing-adapter';
import {
  haversineMeters,
  keyForCoordinate,
  polylineLengthMeters,
} from './geo';
import { buildManeuversFromPath } from './maneuver-builder';
import {
  edgeCostMeters,
  estimateDurationSeconds,
  type RoutingProfileId,
} from './routing-profiles';

/** Snap tolerance onto the loaded road graph. */
const ON_ROAD_SNAP_MAX_M = 350;
/** How many distinct alternatives to search for (including the best). */
const MAX_ALTERNATIVES = 3;
/** Reject an alternative if it reuses too much of a previous path. */
const MAX_OVERLAP_RATIO = 0.72;
/** Reject alternatives that are wildly longer than the best. */
const MAX_LENGTH_RATIO = 1.55;
/** Multiply cost of edges used on prior alternatives. */
const USED_EDGE_PENALTY = 6;

interface LineStringGeometry {
  type: 'LineString';
  coordinates: Coordinate[];
}

interface NetworkFeature {
  type: 'Feature';
  properties?: {
    oneway?: string | null;
    highway?: string | null;
    name?: string | null;
    osm_id?: number | null;
  } | null;
  geometry: LineStringGeometry | { type: string; coordinates?: unknown };
}

export interface NetworkFeatureCollection {
  type: 'FeatureCollection';
  name?: string;
  attribution?: string;
  region?: {
    id?: string;
    label?: string;
    bbox?: [number, number, number, number];
  };
  features: NetworkFeature[];
}

interface GraphEdge {
  id: string;
  to: string;
  meters: number;
  highway: string;
  geometry: Coordinate[];
}

interface GraphNode {
  coordinate: Coordinate;
  edges: GraphEdge[];
}

export interface RoutingNetworkMeta {
  id: string;
  label: string;
  attribution: string;
  bbox?: [number, number, number, number];
  featureCount: number;
  engine: 'graph' | 'valhalla';
}

export interface RouteOptions {
  profile?: RoutingProfileId;
  /** Max alternatives including the primary (capped). */
  alternatives?: number;
}

/**
 * Offline road-network router: directed graph (oneway-aware) + profile A*
 * and a few corridor alternatives (not every path on Earth).
 */
export class OfflineGraphEngine {
  private nodes = new Map<string, GraphNode>();
  private ready = false;
  private meta: RoutingNetworkMeta = {
    id: 'none',
    label: 'No network loaded',
    attribution: '',
    featureCount: 0,
    engine: 'graph',
  };

  isReady(): boolean {
    return this.ready && this.nodes.size > 0;
  }

  getMeta(): RoutingNetworkMeta {
    return this.meta;
  }

  coversPoints(start: Coordinate, end: Coordinate): boolean {
    if (!this.isReady()) return false;
    const a = this.snapToNearestNode(start);
    const b = this.snapToNearestNode(end);
    return (
      a != null &&
      b != null &&
      a.distanceMeters <= ON_ROAD_SNAP_MAX_M &&
      b.distanceMeters <= ON_ROAD_SNAP_MAX_M
    );
  }

  loadFeatureCollection(
    collection: NetworkFeatureCollection,
    meta?: Partial<RoutingNetworkMeta>,
  ): void {
    this.nodes.clear();
    this.ready = false;

    for (const feature of collection.features) {
      this.addLineFeature(feature);
    }

    this.meta = {
      id: meta?.id ?? collection.region?.id ?? 'local-network',
      label:
        meta?.label ??
        collection.region?.label ??
        collection.name ??
        'Local road network',
      attribution:
        meta?.attribution ??
        collection.attribution ??
        '© OpenStreetMap contributors (ODbL)',
      bbox: meta?.bbox ?? collection.region?.bbox,
      featureCount: collection.features.length,
      engine: 'graph',
    };
    this.ready = this.nodes.size > 0;
  }

  async loadFromUrl(url: string): Promise<RoutingNetworkMeta> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load routing network (${response.status})`);
    }
    const collection = (await response.json()) as NetworkFeatureCollection;
    this.loadFeatureCollection(collection);
    return this.meta;
  }

  calculateRoute(
    start: Coordinate,
    end: Coordinate,
    options: RouteOptions = {},
  ): CalculatedRoute {
    const routes = this.calculateRoutes(start, end, options);
    if (routes.length === 0) {
      throw new Error('No connecting road path found');
    }
    return routes[0]!;
  }

  /**
   * Returns up to N distinct on-road alternatives for the corridor.
   * Does not enumerate every possible path worldwide.
   */
  calculateRoutes(
    start: Coordinate,
    end: Coordinate,
    options: RouteOptions = {},
  ): CalculatedRoute[] {
    if (!this.isReady()) {
      throw new Error('Road network is not loaded');
    }

    const profile = options.profile ?? 'fastest';
    const want = Math.min(
      MAX_ALTERNATIVES,
      Math.max(1, options.alternatives ?? MAX_ALTERNATIVES),
    );

    const startSnap = this.snapToNearestNode(start);
    const endSnap = this.snapToNearestNode(end);
    if (!startSnap || !endSnap) {
      throw new Error('Could not snap start/end onto roads');
    }
    if (startSnap.distanceMeters > ON_ROAD_SNAP_MAX_M) {
      throw new Error('Start is too far from the nearest road');
    }
    if (endSnap.distanceMeters > ON_ROAD_SNAP_MAX_M) {
      throw new Error('Destination is too far from the nearest road');
    }

    const penalized = new Map<string, number>();
    const accepted: CalculatedRoute[] = [];
    const acceptedEdgeSets: Array<Set<string>> = [];

    for (let attempt = 0; attempt < want * 3 && accepted.length < want; attempt++) {
      const found = this.aStar(
        startSnap.key,
        endSnap.key,
        profile,
        penalized,
      );
      if (!found) break;

      const route = this.buildRouteFromKeys(
        found.pathKeys,
        found.edgeIds,
        found.highways,
        start,
        end,
        profile,
        accepted.length,
      );

      const edgeSet = new Set(found.edgeIds);
      const tooSimilar = acceptedEdgeSets.some(
        (prev) => overlapRatio(prev, edgeSet) > MAX_OVERLAP_RATIO,
      );
      const tooLong =
        accepted.length > 0 &&
        route.distanceMeters > accepted[0]!.distanceMeters * MAX_LENGTH_RATIO;

      if (!tooSimilar && !tooLong) {
        accepted.push(route);
        acceptedEdgeSets.push(edgeSet);
      }

      // Penalize used edges so the next search finds a different corridor.
      for (const edgeId of found.edgeIds) {
        penalized.set(edgeId, (penalized.get(edgeId) ?? 1) * USED_EDGE_PENALTY);
      }
    }

    if (accepted.length === 0) {
      throw new Error(
        'No connecting road path found (check one-way restrictions)',
      );
    }

    return accepted;
  }

  private buildRouteFromKeys(
    pathKeys: string[],
    edgeIds: string[],
    highways: string[],
    start: Coordinate,
    end: Coordinate,
    profile: RoutingProfileId,
    index: number,
  ): CalculatedRoute {
    const coordinates = this.expandPathGeometry(pathKeys);
    if (coordinates.length < 2) {
      throw new Error('Road route geometry is empty');
    }

    if (haversineMeters(start, coordinates[0]!) > 1) {
      coordinates.unshift(start);
    }
    if (haversineMeters(end, coordinates[coordinates.length - 1]!) > 1) {
      coordinates.push(end);
    }

    const distanceMeters = polylineLengthMeters(coordinates);
    const durationSeconds = estimateDurationSeconds(distanceMeters, highways);
    const instructions = buildManeuversFromPath(coordinates);

    return {
      id: `route-${profile}-${index}`,
      profile,
      label: index === 0 ? 'Best match' : `Alternative ${index}`,
      coordinates,
      distanceMeters,
      durationSeconds,
      instructions,
      meta: { edgeCount: edgeIds.length },
    };
  }

  private addLineFeature(feature: NetworkFeature): void {
    if (feature.geometry?.type !== 'LineString') return;
    const coords = feature.geometry.coordinates as Coordinate[];
    if (!Array.isArray(coords) || coords.length < 2) return;

    const highway = feature.properties?.highway ?? 'road';
    const oneway = String(feature.properties?.oneway ?? '').toLowerCase();
    const impliedOneway =
      oneway === '' &&
      (highway === 'motorway' ||
        highway === 'motorway_link' ||
        highway === 'trunk_link');
    const forwardOnly =
      oneway === 'yes' || oneway === 'true' || oneway === '1' || impliedOneway;
    const reverseOnly = oneway === '-1';
    const osmId = feature.properties?.osm_id ?? 'x';

    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i]!;
      const b = coords[i + 1]!;
      if (
        !Array.isArray(a) ||
        !Array.isArray(b) ||
        a.length < 2 ||
        b.length < 2
      ) {
        continue;
      }
      const meters = haversineMeters(a, b);
      if (meters < 0.2) continue;
      const aKey = keyForCoordinate(a);
      const bKey = keyForCoordinate(b);
      this.ensureNode(aKey, a);
      this.ensureNode(bKey, b);

      if (!reverseOnly) {
        this.nodes.get(aKey)!.edges.push({
          id: `${osmId}:${i}:fwd`,
          to: bKey,
          meters,
          highway,
          geometry: [a, b],
        });
      }
      if (!forwardOnly) {
        this.nodes.get(bKey)!.edges.push({
          id: `${osmId}:${i}:rev`,
          to: aKey,
          meters,
          highway,
          geometry: [b, a],
        });
      }
    }
  }

  private ensureNode(key: string, coordinate: Coordinate): void {
    if (!this.nodes.has(key)) {
      this.nodes.set(key, { coordinate, edges: [] });
    }
  }

  private snapToNearestNode(
    point: Coordinate,
  ): { key: string; distanceMeters: number } | null {
    let bestKey: string | null = null;
    let best = Infinity;
    for (const [key, node] of this.nodes) {
      const d = haversineMeters(point, node.coordinate);
      if (d < best) {
        best = d;
        bestKey = key;
      }
    }
    if (!bestKey) return null;
    return { key: bestKey, distanceMeters: best };
  }

  private aStar(
    startKey: string,
    endKey: string,
    profile: RoutingProfileId,
    penalized: Map<string, number>,
  ): { pathKeys: string[]; edgeIds: string[]; highways: string[] } | null {
    if (startKey === endKey) {
      return { pathKeys: [startKey], edgeIds: [], highways: [] };
    }

    const endNode = this.nodes.get(endKey);
    if (!endNode) return null;

    const open = new Set<string>([startKey]);
    const cameFrom = new Map<string, string>();
    const cameViaEdge = new Map<string, GraphEdge>();
    const gScore = new Map<string, number>([[startKey, 0]]);
    const fScore = new Map<string, number>([
      [
        startKey,
        haversineMeters(
          this.nodes.get(startKey)!.coordinate,
          endNode.coordinate,
        ),
      ],
    ]);

    while (open.size > 0) {
      let current: string | null = null;
      let bestF = Infinity;
      for (const key of open) {
        const f = fScore.get(key) ?? Infinity;
        if (f < bestF) {
          bestF = f;
          current = key;
        }
      }
      if (!current) break;
      if (current === endKey) {
        return this.reconstructPath(cameFrom, cameViaEdge, current);
      }

      open.delete(current);
      const node = this.nodes.get(current);
      if (!node) continue;
      const gCurrent = gScore.get(current) ?? Infinity;

      for (const edge of node.edges) {
        const base = edgeCostMeters(edge.meters, edge.highway, profile);
        const penalty = penalized.get(edge.id) ?? 1;
        const tentative = gCurrent + base * penalty;
        if (tentative >= (gScore.get(edge.to) ?? Infinity)) continue;
        cameFrom.set(edge.to, current);
        cameViaEdge.set(edge.to, edge);
        gScore.set(edge.to, tentative);
        const neighbor = this.nodes.get(edge.to);
        if (!neighbor) continue;
        fScore.set(
          edge.to,
          tentative + haversineMeters(neighbor.coordinate, endNode.coordinate),
        );
        open.add(edge.to);
      }
    }

    return null;
  }

  private reconstructPath(
    cameFrom: Map<string, string>,
    cameViaEdge: Map<string, GraphEdge>,
    current: string,
  ): { pathKeys: string[]; edgeIds: string[]; highways: string[] } {
    const pathKeys = [current];
    const edgeIds: string[] = [];
    const highways: string[] = [];
    while (cameFrom.has(current)) {
      const edge = cameViaEdge.get(current);
      if (edge) {
        edgeIds.unshift(edge.id);
        highways.unshift(edge.highway);
      }
      current = cameFrom.get(current)!;
      pathKeys.unshift(current);
    }
    return { pathKeys, edgeIds, highways };
  }

  private expandPathGeometry(pathKeys: string[]): Coordinate[] {
    const coords: Coordinate[] = [];
    for (let i = 0; i < pathKeys.length; i++) {
      const key = pathKeys[i]!;
      const node = this.nodes.get(key);
      if (!node) continue;

      if (i === 0) {
        coords.push(node.coordinate);
        continue;
      }

      const prevKey = pathKeys[i - 1]!;
      const prev = this.nodes.get(prevKey);
      const edge = prev?.edges.find((e) => e.to === key);
      if (edge && edge.geometry.length > 1) {
        for (let j = 1; j < edge.geometry.length; j++) {
          coords.push(edge.geometry[j]!);
        }
      } else {
        coords.push(node.coordinate);
      }
    }
    return coords;
  }
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const id of a) {
    if (b.has(id)) shared += 1;
  }
  return shared / Math.min(a.size, b.size);
}

export const offlineGraphEngine = new OfflineGraphEngine();
