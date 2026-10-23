/**
 * Route preference profiles for the offline graph engine.
 * "Less traffic" is a road-class heuristic — not live congestion data.
 */

export type RoutingProfileId = 'fastest' | 'shortest' | 'less_traffic';

export interface RoutingProfile {
  id: RoutingProfileId;
  label: string;
  shortLabel: string;
  description: string;
}

export const ROUTING_PROFILES: RoutingProfile[] = [
  {
    id: 'fastest',
    label: 'Fastest',
    shortLabel: 'Fast',
    description: 'Prefer higher-speed roads for lower ETA',
  },
  {
    id: 'shortest',
    label: 'Shortest',
    shortLabel: 'Short',
    description: 'Minimize distance on the road network',
  },
  {
    id: 'less_traffic',
    label: 'Less traffic',
    shortLabel: 'Quiet',
    description:
      'Prefer quieter streets; avoids motorways/arterials (not live traffic)',
  },
];

export function getProfile(id: RoutingProfileId): RoutingProfile {
  return ROUTING_PROFILES.find((p) => p.id === id) ?? ROUTING_PROFILES[0]!;
}

/** Typical motorcycle touring speeds (m/s) by highway class. */
export function highwaySpeedMps(highway: string): number {
  switch (highway) {
    case 'motorway':
    case 'motorway_link':
      return 28; // ~100 km/h
    case 'trunk':
    case 'trunk_link':
      return 22; // ~80 km/h
    case 'primary':
    case 'primary_link':
      return 16; // ~58 km/h
    case 'secondary':
    case 'secondary_link':
      return 13; // ~47 km/h
    case 'tertiary':
    case 'tertiary_link':
      return 11; // ~40 km/h
    case 'unclassified':
    case 'residential':
      return 9; // ~32 km/h
    case 'living_street':
      return 6;
    case 'service':
      return 5;
    default:
      return 10;
  }
}

/** Fastest any edge can be after maxspeed / lane boosts (~108 km/h). */
export const MAX_SPEED_MPS = 30;

/** What the cost function needs to know about one directed graph edge. */
export interface CostedEdge {
  meters: number;
  /** Ride time including `delaySeconds`. */
  seconds: number;
  /** Expected wait at a signal, stop sign, level crossing or toll booth. */
  delaySeconds: number;
  highway: string;
}

/**
 * Edge cost for A*. Lower is better.
 * "fastest" is ride time (incl. signal waits); "less_traffic" pushes the
 * search onto quieter classes and away from signalled junctions.
 */
export function edgeCost(edge: CostedEdge, profile: RoutingProfileId): number {
  if (edge.meters <= 0 && edge.delaySeconds <= 0) return 0;

  switch (profile) {
    case 'shortest':
      return edge.meters;
    case 'fastest':
      // Cost ≈ time in seconds, scaled to meter-ish magnitude.
      return edge.seconds * 10;
    case 'less_traffic':
      return (
        edge.meters * quietClassPenalty(edge.highway) + edge.delaySeconds * 10
      );
    default:
      return edge.meters;
  }
}

/** Every highway class the cost tables distinguish, plus one unknown class. */
const COSTED_HIGHWAY_CLASSES = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'road',
];

/**
 * Cheapest cost any edge can have per meter under `profile`. Scaling the
 * straight-line A* heuristic by this keeps it from overestimating, so the
 * search still returns the cheapest path.
 */
export function minCostPerMeter(profile: RoutingProfileId): number {
  switch (profile) {
    case 'fastest':
      return 10 / MAX_SPEED_MPS;
    case 'less_traffic':
      return Math.min(...COSTED_HIGHWAY_CLASSES.map(quietClassPenalty));
    default:
      return 1;
  }
}

const PREFS_ALLOW_EXPRESSWAYS = 'tc.allowExpressways';

/**
 * Whether two-wheelers may use motorways / expressways not explicitly
 * tagged for them. Off by default: most Indian expressways ban bikes.
 */
export function loadAllowExpressways(): boolean {
  try {
    return localStorage.getItem(PREFS_ALLOW_EXPRESSWAYS) === '1';
  } catch {
    return false;
  }
}

export function saveAllowExpressways(allow: boolean): void {
  try {
    localStorage.setItem(PREFS_ALLOW_EXPRESSWAYS, allow ? '1' : '0');
  } catch {
    // ignore
  }
}

function quietClassPenalty(highway: string): number {
  switch (highway) {
    case 'motorway':
    case 'motorway_link':
      return 4.5;
    case 'trunk':
    case 'trunk_link':
      return 3.2;
    case 'primary':
    case 'primary_link':
      return 2.2;
    case 'secondary':
    case 'secondary_link':
      return 1.4;
    case 'tertiary':
    case 'tertiary_link':
      return 1.05;
    case 'residential':
    case 'living_street':
    case 'unclassified':
      return 0.85;
    case 'service':
      return 1.1;
    default:
      return 1.2;
  }
}
