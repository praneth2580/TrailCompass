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

/**
 * Edge cost for A*. Lower is better.
 * Penalties for less_traffic push the search onto quieter classes.
 */
export function edgeCostMeters(
  meters: number,
  highway: string,
  profile: RoutingProfileId,
): number {
  if (meters <= 0) return 0;

  switch (profile) {
    case 'shortest':
      return meters;
    case 'fastest': {
      const speed = Math.max(3, highwaySpeedMps(highway));
      // Cost ≈ time in seconds, scaled to meter-ish magnitude.
      return (meters / speed) * 10;
    }
    case 'less_traffic': {
      const classPenalty = quietClassPenalty(highway);
      return meters * classPenalty;
    }
    default:
      return meters;
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

export function estimateDurationSeconds(
  meters: number,
  highwaySamples: string[],
): number {
  if (highwaySamples.length === 0) {
    return Math.max(30, Math.round(meters / 11));
  }
  // Average speed across sampled classes along the path.
  let speedSum = 0;
  for (const h of highwaySamples) speedSum += highwaySpeedMps(h);
  const avg = Math.max(4, speedSum / highwaySamples.length);
  return Math.max(30, Math.round(meters / avg));
}
