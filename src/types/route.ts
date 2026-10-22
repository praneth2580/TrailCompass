import type {
  CalculatedRoute,
  Coordinate,
  TurnInstruction,
} from '../routing/routing-adapter';
import type { RoutingProfileId } from '../routing/routing-profiles';

export type { Coordinate, TurnInstruction };

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
