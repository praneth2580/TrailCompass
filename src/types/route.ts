import type {
  CalculatedRoute,
  Coordinate,
  TurnInstruction,
} from '../routing/routing-adapter';
import type { RoutingProfileId } from '../routing/routing-profiles';

export type { Coordinate, TurnInstruction };

/**
 * Names for a trip's destination and stops (in `waypoints` order), so a
 * reopened trip shows "Chiplun" rather than "Stop 1".
 */
export interface SavedPlaces {
  end?: string;
  /** The destination's address line. */
  endNotes?: string;
  stops?: Array<{ name: string; kind: 'fuel' | 'food' | 'manual'; notes?: string }>;
}

export interface SavedRoute {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  start: Coordinate;
  end: Coordinate;
  waypoints: Coordinate[];
  coordinates: Coordinate[];
  distanceMeters: number;
  durationSeconds: number;
  instructions: TurnInstruction[];
  profile?: RoutingProfileId;
  label?: string;
  /** Absent on trips saved before names were kept. */
  places?: SavedPlaces;
}

/** Portable file envelope for sharing routes across devices. */
export interface TrailCompassRouteFile {
  format: 'trailcompass-route';
  version: 1;
  exportedAt: string;
  app: 'trailcompass';
  route: SavedRoute;
}

export interface Destination {
  id: string;
  name: string;
  coordinate: Coordinate;
  createdAt: string;
}

export function calculatedToSavedRoute(
  route: CalculatedRoute,
  name: string,
  extras?: {
    start?: Coordinate;
    end?: Coordinate;
    waypoints?: Coordinate[];
    id?: string;
    createdAt?: string;
    places?: SavedPlaces;
  },
): SavedRoute {
  const coords = route.coordinates;
  const start = extras?.start ?? coords[0] ?? ([0, 0] as Coordinate);
  const end =
    extras?.end ?? coords[coords.length - 1] ?? ([0, 0] as Coordinate);
  const now = new Date().toISOString();
  return {
    id: extras?.id ?? crypto.randomUUID(),
    name,
    createdAt: extras?.createdAt ?? now,
    updatedAt: now,
    start,
    end,
    waypoints: extras?.waypoints ?? [],
    coordinates: coords,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    instructions: route.instructions,
    profile: route.profile,
    label: route.label,
    ...(extras?.places ? { places: extras.places } : {}),
  };
}

export function savedToCalculatedRoute(saved: SavedRoute): CalculatedRoute {
  return {
    id: saved.id,
    coordinates: saved.coordinates,
    distanceMeters: saved.distanceMeters,
    durationSeconds: saved.durationSeconds,
    instructions: saved.instructions,
    profile: saved.profile,
    label: saved.label ?? saved.name,
  };
}
