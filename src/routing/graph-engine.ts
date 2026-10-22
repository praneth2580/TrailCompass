import type { CalculatedRoute, Coordinate } from './routing-adapter';
import {
  haversineMeters,
  keyForCoordinate,
  polylineLengthMeters,
} from './geo';
import { buildManeuversFromPath } from './maneuver-builder';

/** Snap tolerance onto the loaded road graph. */
const ON_ROAD_SNAP_MAX_M = 350;

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
  to: string;
  weight: number;
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

/** Default motorcycle-ish speed for ETA (m/s). */
const DEFAULT_SPEED_MPS = 11; // ~40 km/h urban touring

/**
 * Offline road-network router: builds a directed weighted graph from
 * GeoJSON LineStrings (honoring oneway) and runs A* between snapped endpoints.
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

  /** True when both points can snap onto the currently loaded graph. */
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

  calculateRoute(start: Coordinate, end: Coordinate): CalculatedRoute {
    if (!this.isReady()) {
      throw new Error('Road network is not loaded');
    }

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

    const pathKeys = this.aStar(startSnap.key, endSnap.key);
    if (!pathKeys || pathKeys.length === 0) {
      throw new Error('No connecting road path found (check one-way restrictions)');
    }

    const coordinates = this.expandPathGeometry(pathKeys);
    if (coordinates.length < 2) {
      throw new Error('Road route geometry is empty');
    }

    // Short connectors from the pin onto the snapped road graph.
    if (haversineMeters(start, coordinates[0]!) > 1) {
      coordinates.unshift(start);
    }
    if (haversineMeters(end, coordinates[coordinates.length - 1]!) > 1) {
      coordinates.push(end);
    }

    const distanceMeters = polylineLengthMeters(coordinates);
    const durationSeconds = Math.max(
      30,
      Math.round(distanceMeters / DEFAULT_SPEED_MPS),
    );
    const instructions = buildManeuversFromPath(coordinates);

    return {
      coordinates,
      distanceMeters,
      durationSeconds,
      instructions,
    };
  }

  private addLineFeature(feature: NetworkFeature): void {
    if (feature.geometry?.type !== 'LineString') return;
    const coords = feature.geometry.coordinates as Coordinate[];
    if (!Array.isArray(coords) || coords.length < 2) return;

    const highway = feature.properties?.highway ?? '';
    const oneway = String(feature.properties?.oneway ?? '').toLowerCase();
    const impliedOneway =
      oneway === '' &&
      (highway === 'motorway' ||
        highway === 'motorway_link' ||
        highway === 'trunk_link');
    const forwardOnly =
      oneway === 'yes' || oneway === 'true' || oneway === '1' || impliedOneway;
    const reverseOnly = oneway === '-1';
    const highwayFactor = highwayWeightFactor(highway);

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
      const weight = meters * highwayFactor;
      const aKey = keyForCoordinate(a);
      const bKey = keyForCoordinate(b);
      this.ensureNode(aKey, a);
      this.ensureNode(bKey, b);

      // Directed edges: honor OSM oneway (and implied motorway direction).
      if (!reverseOnly) {
        this.nodes.get(aKey)!.edges.push({
          to: bKey,
          weight,
          geometry: [a, b],
        });
      }
      if (!forwardOnly) {
        this.nodes.get(bKey)!.edges.push({
          to: aKey,
          weight,
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

  private aStar(startKey: string, endKey: string): string[] | null {
    if (startKey === endKey) return [startKey];

    const endNode = this.nodes.get(endKey);
    if (!endNode) return null;

    const open = new Set<string>([startKey]);
    const cameFrom = new Map<string, string>();
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
        return this.reconstruct(cameFrom, current);
      }

      open.delete(current);
      const node = this.nodes.get(current);
      if (!node) continue;
      const gCurrent = gScore.get(current) ?? Infinity;

      for (const edge of node.edges) {
        const tentative = gCurrent + edge.weight;
        if (tentative >= (gScore.get(edge.to) ?? Infinity)) continue;
        cameFrom.set(edge.to, current);
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

  private reconstruct(
    cameFrom: Map<string, string>,
    current: string,
  ): string[] {
    const path = [current];
    while (cameFrom.has(current)) {
      current = cameFrom.get(current)!;
      path.unshift(current);
    }
    return path;
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

/** Lower factor = preferred. Service roads cost more so A* stays on main roads. */
function highwayWeightFactor(highway: string | null | undefined): number {
  switch (highway) {
    case 'motorway':
    case 'motorway_link':
      return 0.85;
    case 'trunk':
    case 'trunk_link':
      return 0.9;
    case 'primary':
    case 'primary_link':
      return 0.95;
    case 'secondary':
    case 'secondary_link':
      return 1;
    case 'tertiary':
    case 'tertiary_link':
      return 1.05;
    case 'unclassified':
    case 'residential':
    case 'living_street':
      return 1.15;
    case 'service':
      return 1.45;
    default:
      return 1.2;
  }
}

export const offlineGraphEngine = new OfflineGraphEngine();
