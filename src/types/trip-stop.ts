import type { Coordinate } from '../routing/routing-adapter';

export type StopKind = 'destination' | 'fuel' | 'food' | 'manual';

export interface TripStop {
  id: string;
  kind: StopKind;
  coordinate: Coordinate;
  name: string;
  notes?: string;
}

export type PoiKind = 'fuel' | 'food';

export interface PlaceHit {
  id: string;
  name: string;
  coordinate: Coordinate;
  subtitle?: string;
  kind?: StopKind | PoiKind;
  distanceMeters?: number;
}

export function createTripStop(
  kind: StopKind,
  coordinate: Coordinate,
  name: string,
  notes?: string,
): TripStop {
  return {
    id: crypto.randomUUID(),
    kind,
    coordinate,
    name: name.trim() || defaultStopName(kind),
    notes,
  };
}

export function defaultStopName(kind: StopKind): string {
  switch (kind) {
    case 'destination':
      return 'Destination';
    case 'fuel':
      return 'Fuel stop';
    case 'food':
      return 'Food stop';
    case 'manual':
      return 'Custom stop';
  }
}

export function stopKindLabel(kind: StopKind): string {
  switch (kind) {
    case 'destination':
      return 'Destination';
    case 'fuel':
      return 'Fuel';
    case 'food':
      return 'Food';
    case 'manual':
      return 'Custom';
  }
}

export function formatCoordShort(coordinate: Coordinate): string {
  return `${coordinate[1].toFixed(4)}, ${coordinate[0].toFixed(4)}`;
}

/** Intermediate waypoints for the router (everything before the final destination). */
export function itineraryWaypoints(
  destination: TripStop | null,
  stops: TripStop[],
): Coordinate[] {
  if (!destination) return [];
  return stops.map((s) => s.coordinate);
}

export function itineraryEnd(
  destination: TripStop | null,
): Coordinate | null {
  return destination?.coordinate ?? null;
}
