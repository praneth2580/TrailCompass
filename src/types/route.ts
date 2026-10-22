import type { Coordinate, TurnInstruction } from '../routing/routing-adapter';

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
}

export interface Destination {
  id: string;
  name: string;
  coordinate: Coordinate;
  createdAt: string;
}
