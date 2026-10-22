export type Coordinate = [longitude: number, latitude: number];

export interface TurnInstruction {
  text: string;
  distanceMeters: number;
  maneuver?: string;
}

export interface CalculatedRoute {
  coordinates: Coordinate[];
  distanceMeters: number;
  durationSeconds: number;
  instructions: TurnInstruction[];
}

export interface RoutingAdapter {
  calculateRoute(
    start: Coordinate,
    end: Coordinate,
    waypoints?: Coordinate[],
  ): Promise<CalculatedRoute>;
}

export { offlineRoutingAdapter as defaultRoutingAdapter } from './offline-adapter';
