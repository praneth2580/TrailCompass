import type { CalculatedRoute, Coordinate } from './routing-adapter';
import {
  haversineMeters,
  keyForCoordinate,
  polylineLengthMeters,
  toRad,
} from './geo';
import { buildManeuversFromPath } from './maneuver-builder';
import { MinHeap } from './min-heap';
import type { NetworkCoverage } from './network-coverage';
import {
  CONTROL_DELAY_SECONDS,
  roadAttributes,
  type NetworkControl,
  type RoadTags,
} from './road-attributes';
import {
  edgeCost,
  minCostPerMeter,
  type RoutingProfileId,
} from './routing-profiles';

/** Snap tolerance onto the loaded road graph. */
const ON_ROAD_SNAP_MAX_M = 350;
/** Grid cell size for the snapping index (~550 m of latitude). */
const SNAP_CELL_DEG = 0.005;
const METERS_PER_DEG = 111_320;
/** How many distinct alternatives to search for (including the best). */
const MAX_ALTERNATIVES = 3;
/** Reject an alternative if it reuses too much of a previous path. */
const MAX_OVERLAP_RATIO = 0.72;
/** Reject alternatives that are wildly longer than the best. */
const MAX_LENGTH_RATIO = 1.55;
/** Multiply cost of edges used on prior alternatives. */
const USED_EDGE_PENALTY = 6;
/** Signals closer than this are one junction (dual carriageways). */
const SIGNAL_CLUSTER_M = 50;
const SIGNAL_CELL_DEG = 0.001;
/** Access=destination roads: fine to start/end on, poor as a through route. */
const DESTINATION_ONLY_PENALTY = 5;

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
    /** Subset of OSM way tags (see ROAD_TAG_KEYS). */
    tags?: RoadTags | null;
  } | null;
  geometry: LineStringGeometry | { type: string; coordinates?: unknown };
}

/**
 * The loaded roads don't connect the two points (or don't reach them).
 * Callers may retry with a wider download.
 */
export class NoRoadPathError extends Error {
  override name = 'NoRoadPathError';
}

export interface NetworkFeatureCollection {
  type: 'FeatureCollection';
  name?: string;
  attribution?: string;
  region?: {
    id?: string;
    label?: string;
    bbox?: [number, number, number, number];
    coverage?: NetworkCoverage;
  };
  features: NetworkFeature[];
  /** Signals, stop signs, level crossings, toll booths on the ways. */
  controls?: NetworkControl[];
  /** Turn restrictions (via-node only). */
  restrictions?: NetworkRestriction[];
}

export interface NetworkRestriction {
  fromWay: number;
  via: Coordinate;
  toWay: number;
  /** `no_*` forbids the turn; `only_*` forbids every other exit. */
  kind: 'no' | 'only';
}

interface GraphEdge {
  id: string;
  to: string;
  wayId: number;
  meters: number;
  /** Ride time including `delaySeconds`. */
  seconds: number;
  delaySeconds: number;
  highway: string;
  expressway: boolean;
  destinationOnly: boolean;
  geometry: Coordinate[];
}

interface GraphNode {
  coordinate: Coordinate;
  edges: GraphEdge[];
  /** Touched by at least one non-expressway edge. */
  ordinary: boolean;
}

/** Exits allowed when arriving at a via node from one way. */
interface TurnRule {
  no: Set<number>;
  only: Set<number> | null;
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
  /** Ride motorways / expressways not tagged for motorcycles. Default false. */
  allowExpressways?: boolean;
}

interface FoundPath {
  edges: GraphEdge[];
  startKey: string;
}

/**
 * Offline road-network router: directed graph (oneway-aware) + profile A*
 * and a few corridor alternatives (not every path on Earth).
 */
export class OfflineGraphEngine {
  private nodes = new Map<string, GraphNode>();
  /** Node keys bucketed by grid cell, so snapping avoids a full scan. */
  private grid = new Map<string, string[]>();
  private gridBounds = emptyGridBounds();
  private controls = new Map<string, NetworkControl>();
  private signalCluster = new Map<string, number>();
  /** via node key → from way id → turn rule. */
  private turnRules = new Map<string, Map<number, TurnRule>>();
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
    return (
      this.snapToNearestNode(start, ON_ROAD_SNAP_MAX_M) != null &&
      this.snapToNearestNode(end, ON_ROAD_SNAP_MAX_M) != null
    );
  }

  /**
   * Nearest road coordinate to `point`.
   * Used to pull synthetic long-route vias onto the loaded corridor.
   */
  nearestRoadCoordinate(
    point: Coordinate,
    maxMeters = 8_000,
    options: { allowExpressways?: boolean } = {},
  ): Coordinate | null {
    if (!this.isReady()) return null;
    const snap = this.snapToNearestNode(
      point,
      maxMeters,
      options.allowExpressways ?? true,
    );
    if (!snap) return null;
    return this.nodes.get(snap.key)?.coordinate ?? null;
  }

  loadFeatureCollection(
    collection: NetworkFeatureCollection,
    meta?: Partial<RoutingNetworkMeta>,
  ): void {
    this.nodes.clear();
    this.grid.clear();
    this.gridBounds = emptyGridBounds();
    this.ready = false;
    this.controls = new Map(
      (collection.controls ?? []).map((c) => [keyForCoordinate(c.coordinate), c]),
    );
    this.signalCluster = clusterSignals(collection.controls ?? []);
    this.turnRules = buildTurnRules(collection.restrictions ?? []);

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
      throw new NoRoadPathError('No connecting road path found');
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
    const allowExpressways = options.allowExpressways ?? false;
    const want = Math.min(
      MAX_ALTERNATIVES,
      Math.max(1, options.alternatives ?? MAX_ALTERNATIVES),
    );

    const startSnap = this.snapToNearestNode(
      start,
      ON_ROAD_SNAP_MAX_M,
      allowExpressways,
    );
    if (!startSnap) {
      throw new NoRoadPathError('Start is too far from the nearest road');
    }
    const endSnap = this.snapToNearestNode(
      end,
      ON_ROAD_SNAP_MAX_M,
      allowExpressways,
    );
    if (!endSnap) {
      throw new NoRoadPathError('Destination is too far from the nearest road');
    }

    const penalized = new Map<string, number>();
    const accepted: CalculatedRoute[] = [];
    const acceptedEdgeSets: Array<Set<string>> = [];

    for (let attempt = 0; attempt < want * 3 && accepted.length < want; attempt++) {
      const found = this.aStar(
        startSnap.key,
        endSnap.key,
        profile,
        allowExpressways,
        penalized,
      );
      if (!found) break;

      const route = this.buildRoute(
        found,
        start,
        end,
        profile,
        accepted.length,
      );
      const edgeIds = found.edges.map((edge) => edge.id);

      const edgeSet = new Set(edgeIds);
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
      for (const edgeId of edgeIds) {
        penalized.set(edgeId, (penalized.get(edgeId) ?? 1) * USED_EDGE_PENALTY);
      }
    }

    if (accepted.length === 0) {
      throw new NoRoadPathError(
        allowExpressways
          ? 'No connecting road path found (check one-way restrictions)'
          : 'No connecting road path found without expressways',
      );
    }

    return accepted;
  }

  private buildRoute(
    found: FoundPath,
    start: Coordinate,
    end: Coordinate,
    profile: RoutingProfileId,
    index: number,
  ): CalculatedRoute {
    const coordinates: Coordinate[] = [
      this.nodes.get(found.startKey)!.coordinate,
    ];
    let seconds = 0;
    for (const edge of found.edges) {
      for (let j = 1; j < edge.geometry.length; j++) {
        coordinates.push(edge.geometry[j]!);
      }
      seconds += edge.seconds;
    }

    // Snapped-on stubs from the pin to the road ride at a crawl.
    if (haversineMeters(start, coordinates[0]!) > 1) {
      seconds += haversineMeters(start, coordinates[0]!) / 5;
      coordinates.unshift(start);
    }
    const last = coordinates[coordinates.length - 1]!;
    if (haversineMeters(end, last) > 1) {
      seconds += haversineMeters(end, last) / 5;
      coordinates.push(end);
    }
    if (coordinates.length < 2) {
      throw new Error('Road route geometry is empty');
    }

    const distanceMeters = polylineLengthMeters(coordinates);
    const instructions = buildManeuversFromPath(coordinates);

    return {
      id: `route-${profile}-${index}`,
      profile,
      label: index === 0 ? 'Best match' : `Alternative ${index}`,
      coordinates,
      distanceMeters,
      durationSeconds: Math.max(30, Math.round(seconds)),
      instructions,
      meta: { edgeCount: found.edges.length },
    };
  }

  private addLineFeature(feature: NetworkFeature): void {
    if (feature.geometry?.type !== 'LineString') return;
    const coords = feature.geometry.coordinates as Coordinate[];
    if (!Array.isArray(coords) || coords.length < 2) return;

    const props = feature.properties;
    const highway = props?.highway ?? 'road';
    const tags: RoadTags = { ...(props?.tags ?? {}) };
    if (tags.oneway == null && props?.oneway != null) {
      tags.oneway = String(props.oneway);
    }
    const road = roadAttributes(highway, tags);
    if (road.access === 'no' || road.oneway === 'closed') return;

    const forwardOnly = road.oneway === 'forward';
    const reverseOnly = road.oneway === 'backward';
    const wayId = props?.osm_id ?? -1;
    const osmId = props?.osm_id ?? 'x';

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
      this.ensureNode(aKey, a, road.expressway);
      this.ensureNode(bKey, b, road.expressway);

      const edge = (
        dir: 'fwd' | 'rev',
        fromKey: string,
        toKey: string,
        geometry: Coordinate[],
      ): GraphEdge => {
        const delaySeconds = this.delayEntering(fromKey, toKey, dir === 'fwd');
        return {
          id: `${osmId}:${i}:${dir}`,
          to: toKey,
          wayId,
          meters,
          seconds: meters / road.speedMps + delaySeconds,
          delaySeconds,
          highway,
          expressway: road.expressway,
          destinationOnly: road.access === 'destination',
          geometry,
        };
      };

      if (!reverseOnly) {
        this.nodes.get(aKey)!.edges.push(edge('fwd', aKey, bKey, [a, b]));
      }
      if (!forwardOnly) {
        this.nodes.get(bKey)!.edges.push(edge('rev', bKey, aKey, [b, a]));
      }
    }
  }

  /**
   * Expected wait for an edge arriving at `toKey`. Charged once per signal
   * cluster, so crossing a dual-carriageway junction counts one signal.
   * Depends only on the edge, which keeps A* exact.
   */
  private delayEntering(
    fromKey: string,
    toKey: string,
    forward: boolean,
  ): number {
    const control = this.controls.get(toKey);
    if (!control) return 0;
    if (control.direction && (control.direction === 'forward') !== forward) {
      return 0;
    }
    if (control.kind === 'traffic_signals') {
      const cluster = this.signalCluster.get(toKey);
      if (cluster != null && this.signalCluster.get(fromKey) === cluster) {
        return 0;
      }
    }
    return CONTROL_DELAY_SECONDS[control.kind];
  }

  private ensureNode(
    key: string,
    coordinate: Coordinate,
    expressway: boolean,
  ): void {
    const existing = this.nodes.get(key);
    if (existing) {
      if (!expressway) existing.ordinary = true;
      return;
    }
    this.nodes.set(key, { coordinate, edges: [], ordinary: !expressway });

    const x = snapCell(coordinate[0]);
    const y = snapCell(coordinate[1]);
    const cell = cellKey(x, y);
    const bucket = this.grid.get(cell);
    if (bucket) bucket.push(key);
    else this.grid.set(cell, [key]);

    const bounds = this.gridBounds;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
  }

  /**
   * Nearest node within `maxMeters`, searching grid rings outward from the
   * point's cell and stopping once no farther ring can beat the best hit.
   */
  private snapToNearestNode(
    point: Coordinate,
    maxMeters: number,
    allowExpressways = true,
  ): { key: string; distanceMeters: number } | null {
    if (this.grid.size === 0) return null;

    const cx = snapCell(point[0]);
    const cy = snapCell(point[1]);
    const bounds = this.gridBounds;
    const maxRing = Math.max(
      Math.abs(cx - bounds.minX),
      Math.abs(cx - bounds.maxX),
      Math.abs(cy - bounds.minY),
      Math.abs(cy - bounds.maxY),
    );
    // Narrowest cell side near this latitude (longitude shrinks toward the poles).
    const cellMeters =
      SNAP_CELL_DEG *
      METERS_PER_DEG *
      Math.cos(toRad(Math.min(89, Math.abs(point[1]) + 1)));

    let bestKey: string | null = null;
    let best = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      // Any cell `ring` steps out is at least ring - 1 full cells away.
      const ringFloorMeters = Math.max(0, ring - 1) * cellMeters;
      if (ringFloorMeters > Math.min(best, maxMeters)) break;
      for (const [x, y] of ringCells(cx, cy, ring)) {
        const bucket = this.grid.get(cellKey(x, y));
        if (!bucket) continue;
        for (const key of bucket) {
          const node = this.nodes.get(key)!;
          if (!allowExpressways && !node.ordinary) continue;
          const d = haversineMeters(point, node.coordinate);
          if (d < best) {
            best = d;
            bestKey = key;
          }
        }
      }
    }
    if (!bestKey || best > maxMeters) return null;
    return { key: bestKey, distanceMeters: best };
  }

  /**
   * A* over search states. A state is a node key, except at turn-restriction
   * via nodes, where it is `node|fromWay` so the allowed exits can depend on
   * how the rider arrived.
   */
  private aStar(
    startKey: string,
    endKey: string,
    profile: RoutingProfileId,
    allowExpressways: boolean,
    penalized: Map<string, number>,
  ): FoundPath | null {
    if (startKey === endKey) {
      return { edges: [], startKey };
    }

    const endNode = this.nodes.get(endKey);
    if (!endNode) return null;

    // Straight-line distance times the cheapest possible cost per meter never
    // overestimates (and stays consistent, since edge lengths are haversine),
    // so a state's first pop is its cheapest.
    const costScale = minCostPerMeter(profile);
    const heuristic = (coordinate: Coordinate) =>
      haversineMeters(coordinate, endNode.coordinate) * costScale;

    const open = new MinHeap<string>();
    const closed = new Set<string>();
    const cameFrom = new Map<string, string>();
    const cameViaEdge = new Map<string, GraphEdge>();
    const gScore = new Map<string, number>([[startKey, 0]]);
    open.push(startKey, heuristic(this.nodes.get(startKey)!.coordinate));

    while (open.size > 0) {
      const current = open.pop()!.value;
      // Stale heap entry: this state was already settled more cheaply.
      if (closed.has(current)) continue;
      const nodeKey = stateNode(current);
      if (nodeKey === endKey) {
        return this.reconstructPath(cameFrom, cameViaEdge, current, startKey);
      }
      closed.add(current);

      const node = this.nodes.get(nodeKey);
      if (!node) continue;
      const gCurrent = gScore.get(current) ?? Infinity;
      const arrivedOn = cameViaEdge.get(current)?.wayId;
      const rule =
        arrivedOn != null ? this.turnRules.get(nodeKey)?.get(arrivedOn) : undefined;

      for (const edge of node.edges) {
        if (edge.expressway && !allowExpressways) continue;
        if (rule) {
          if (rule.no.has(edge.wayId)) continue;
          if (rule.only && !rule.only.has(edge.wayId)) continue;
        }
        const next = this.turnRules.get(edge.to)?.has(edge.wayId)
          ? `${edge.to}|${edge.wayId}`
          : edge.to;
        if (closed.has(next)) continue;
        const neighbor = this.nodes.get(edge.to);
        if (!neighbor) continue;
        let base = edgeCost(edge, profile);
        if (edge.destinationOnly) base *= DESTINATION_ONLY_PENALTY;
        const penalty = penalized.get(edge.id) ?? 1;
        const tentative = gCurrent + base * penalty;
        if (tentative >= (gScore.get(next) ?? Infinity)) continue;
        cameFrom.set(next, current);
        cameViaEdge.set(next, edge);
        gScore.set(next, tentative);
        open.push(next, tentative + heuristic(neighbor.coordinate));
      }
    }

    return null;
  }

  private reconstructPath(
    cameFrom: Map<string, string>,
    cameViaEdge: Map<string, GraphEdge>,
    current: string,
    startKey: string,
  ): FoundPath {
    const edges: GraphEdge[] = [];
    while (cameFrom.has(current)) {
      const edge = cameViaEdge.get(current);
      if (edge) edges.push(edge);
      current = cameFrom.get(current)!;
    }
    edges.reverse();
    return { edges, startKey };
  }
}

function stateNode(state: string): string {
  const bar = state.indexOf('|');
  return bar < 0 ? state : state.slice(0, bar);
}

/** Union nearby signal nodes into junction clusters (node key → cluster id). */
function clusterSignals(controls: NetworkControl[]): Map<string, number> {
  const signals = controls.filter((c) => c.kind === 'traffic_signals');
  const parent = signals.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };

  const cell = (c: Coordinate) =>
    [Math.floor(c[0] / SIGNAL_CELL_DEG), Math.floor(c[1] / SIGNAL_CELL_DEG)] as const;
  const buckets = new Map<string, number[]>();
  signals.forEach((signal, i) => {
    const [x, y] = cell(signal.coordinate);
    const key = cellKey(x, y);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  });

  signals.forEach((signal, i) => {
    const [x, y] = cell(signal.coordinate);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of buckets.get(cellKey(x + dx, y + dy)) ?? []) {
          if (j <= i) continue;
          if (
            haversineMeters(signal.coordinate, signals[j]!.coordinate) <=
            SIGNAL_CLUSTER_M
          ) {
            parent[find(i)] = find(j);
          }
        }
      }
    }
  });

  return new Map(
    signals.map((signal, i) => [keyForCoordinate(signal.coordinate), find(i)]),
  );
}

function buildTurnRules(
  restrictions: NetworkRestriction[],
): Map<string, Map<number, TurnRule>> {
  const rules = new Map<string, Map<number, TurnRule>>();
  for (const r of restrictions) {
    const viaKey = keyForCoordinate(r.via);
    let byWay = rules.get(viaKey);
    if (!byWay) {
      byWay = new Map();
      rules.set(viaKey, byWay);
    }
    let rule = byWay.get(r.fromWay);
    if (!rule) {
      rule = { no: new Set(), only: null };
      byWay.set(r.fromWay, rule);
    }
    if (r.kind === 'no') rule.no.add(r.toWay);
    else (rule.only ??= new Set()).add(r.toWay);
  }
  return rules;
}

function emptyGridBounds() {
  return { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
}

function snapCell(degrees: number): number {
  return Math.floor(degrees / SNAP_CELL_DEG);
}

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

/** Cells exactly `ring` steps from (cx, cy) in Chebyshev distance. */
function* ringCells(
  cx: number,
  cy: number,
  ring: number,
): Generator<[number, number]> {
  if (ring === 0) {
    yield [cx, cy];
    return;
  }
  for (let dx = -ring; dx <= ring; dx++) {
    yield [cx + dx, cy - ring];
    yield [cx + dx, cy + ring];
  }
  for (let dy = -ring + 1; dy <= ring - 1; dy++) {
    yield [cx - ring, cy + dy];
    yield [cx + ring, cy + dy];
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
