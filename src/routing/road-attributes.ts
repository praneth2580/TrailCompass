import type { Coordinate } from './routing-adapter';
import { MAX_SPEED_MPS, highwaySpeedMps } from './routing-profiles';

/**
 * Two-wheeler reading of OSM way / node tags: who may ride it, which way,
 * whether it's an expressway, how fast it rides, and junction waits.
 */

export type RoadAccess = 'yes' | 'no' | 'destination';
/** `closed` = reversible / alternating lanes we can't time-check. */
export type RoadOneway = 'forward' | 'backward' | 'both' | 'closed';

export interface RoadAttributes {
  access: RoadAccess;
  oneway: RoadOneway;
  /** Motorway-grade road; skipped unless the rider allows expressways. */
  expressway: boolean;
  speedMps: number;
}

/** Way tags the loader keeps so packs stay small. */
export const ROAD_TAG_KEYS = [
  'oneway',
  'oneway:motorcycle',
  'junction',
  'lanes',
  'maxspeed',
  'surface',
  'smoothness',
  'motorroad',
  'expressway',
  'motorcycle',
  'motor_vehicle',
  'vehicle',
  'access',
] as const;

export type RoadTags = Partial<Record<string, string>>;

/** Most specific first: a motorcycle tag beats a general access tag. */
const ACCESS_KEYS = ['motorcycle', 'motor_vehicle', 'vehicle', 'access'];
const DENIED_ACCESS = new Set([
  'no',
  'private',
  'agricultural',
  'forestry',
  'delivery',
  'emergency',
  'military',
]);
const DESTINATION_ACCESS = new Set(['destination', 'customers']);

const UNPAVED_SURFACES = new Set([
  'unpaved',
  'gravel',
  'fine_gravel',
  'dirt',
  'earth',
  'ground',
  'compacted',
  'sand',
  'mud',
  'grass',
  'pebblestone',
]);
const BAD_SMOOTHNESS = new Set([
  'bad',
  'very_bad',
  'horrible',
  'very_horrible',
  'impassable',
]);

export function roadAttributes(
  highway: string,
  tags: RoadTags,
): RoadAttributes {
  const oneway = onewayDirection(highway, tags);
  return {
    access: motorcycleAccess(tags),
    oneway,
    expressway: isExpressway(highway, tags),
    speedMps: roadSpeedMps(highway, tags, oneway),
  };
}

export function motorcycleAccess(tags: RoadTags): RoadAccess {
  for (const key of ACCESS_KEYS) {
    const value = firstValue(tags[key]);
    if (!value) continue;
    if (DENIED_ACCESS.has(value)) return 'no';
    if (DESTINATION_ACCESS.has(value)) return 'destination';
    return 'yes';
  }
  return 'yes';
}

export function onewayDirection(highway: string, tags: RoadTags): RoadOneway {
  const raw = firstValue(tags['oneway:motorcycle'] ?? tags.oneway);
  if (raw === 'reversible' || raw === 'alternating') return 'closed';
  if (raw === '-1' || raw === 'reverse') return 'backward';
  if (raw === 'yes' || raw === 'true' || raw === '1') return 'forward';
  if (raw === 'no' || raw === 'false' || raw === '0') return 'both';

  const junction = firstValue(tags.junction);
  if (junction === 'roundabout' || junction === 'circular') return 'forward';
  if (
    highway === 'motorway' ||
    highway === 'motorway_link' ||
    highway === 'trunk_link'
  ) {
    return 'forward';
  }
  return 'both';
}

export function isExpressway(highway: string, tags: RoadTags): boolean {
  const moto = firstValue(tags.motorcycle);
  if (moto === 'yes' || moto === 'designated') return false;
  return (
    highway === 'motorway' ||
    highway === 'motorway_link' ||
    firstValue(tags.motorroad) === 'yes' ||
    firstValue(tags.expressway) === 'yes'
  );
}

/**
 * Class speed, nudged by posted limit, lanes per direction and surface.
 * Clamped to MAX_SPEED_MPS so the A* heuristic stays admissible.
 */
export function roadSpeedMps(
  highway: string,
  tags: RoadTags,
  oneway: RoadOneway = onewayDirection(highway, tags),
): number {
  const classSpeed = highwaySpeedMps(highway);
  let speed = classSpeed;

  const limit = parseMaxspeedMps(tags.maxspeed);
  if (limit != null) speed = Math.min(limit * 0.9, classSpeed * 1.2);

  const lanes = Number.parseInt(tags.lanes ?? '', 10);
  if (Number.isFinite(lanes) && lanes > 0) {
    const twoWay = oneway === 'both';
    if (twoWay && lanes === 1) {
      // Single-lane road shared by both directions.
      speed *= 0.75;
    } else {
      const perDirection = twoWay ? lanes / 2 : lanes;
      if (perDirection >= 3) speed *= 1.15;
      else if (perDirection >= 2) speed *= 1.05;
    }
  }

  if (UNPAVED_SURFACES.has(firstValue(tags.surface) ?? '')) speed *= 0.55;
  if (BAD_SMOOTHNESS.has(firstValue(tags.smoothness) ?? '')) speed *= 0.7;

  return Math.min(MAX_SPEED_MPS, Math.max(3, speed));
}

/** Numeric maxspeed in m/s ("50", "50 mph"); null for "none", "IN:urban"… */
export function parseMaxspeedMps(raw: string | undefined): number | null {
  const value = firstValue(raw);
  if (!value) return null;
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const kmh = match[2] === 'mph' ? n * 1.609 : n;
  return kmh / 3.6;
}

// ── Junction controls ────────────────────────────────────────────────

export type ControlKind =
  | 'traffic_signals'
  | 'stop'
  | 'give_way'
  | 'level_crossing'
  | 'toll_booth';

/**
 * Expected time lost passing each control. Signals: a ~120 s cycle red
 * about half the time averages ~25 s wait plus slowing down and pulling away.
 */
export const CONTROL_DELAY_SECONDS: Record<ControlKind, number> = {
  traffic_signals: 25,
  stop: 8,
  give_way: 4,
  level_crossing: 25,
  toll_booth: 15,
};

export interface NetworkControl {
  coordinate: Coordinate;
  kind: ControlKind;
  /** Only traffic moving this way along the node's way is affected. */
  direction?: 'forward' | 'backward';
}

/** Overpass node tags → control, or null for nodes we don't time. */
export function controlFromNodeTags(
  coordinate: Coordinate,
  tags: RoadTags,
): NetworkControl | null {
  let kind: ControlKind | null = null;
  let directionTag: string | undefined;
  const highway = firstValue(tags.highway);
  if (highway === 'traffic_signals') {
    kind = 'traffic_signals';
    directionTag = tags['traffic_signals:direction'];
  } else if (highway === 'stop' || highway === 'give_way') {
    kind = highway;
    directionTag = tags.direction;
  } else if (firstValue(tags.railway) === 'level_crossing') {
    kind = 'level_crossing';
  } else if (firstValue(tags.barrier) === 'toll_booth') {
    kind = 'toll_booth';
  }
  if (!kind) return null;

  const direction = firstValue(directionTag);
  return direction === 'forward' || direction === 'backward'
    ? { coordinate, kind, direction }
    : { coordinate, kind };
}

/** "no;yes" → "no"; trimmed and lower-cased. */
function firstValue(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const value = raw.split(';')[0]!.trim().toLowerCase();
  return value === '' ? undefined : value;
}
