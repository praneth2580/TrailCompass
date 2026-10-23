import type { RoutingProfileId } from './routing-profiles';

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
  id?: string;
  profile?: RoutingProfileId;
  label?: string;
  meta?: { edgeCount?: number };
}

export interface RouteRequestOptions {
  waypoints?: Coordinate[];
  profile?: RoutingProfileId;
  /** How many distinct corridor alternatives to return (including best). */
  alternatives?: number;
  /** Ride motorways / expressways not tagged for motorcycles. Default false. */
  allowExpressways?: boolean;
  /** Cancels an in-flight road download when the rider changes the trip. */
  signal?: AbortSignal;
}

export interface RoutingAdapter {
  calculateRoute(
    start: Coordinate,
    end: Coordinate,
    waypointsOrOptions?: Coordinate[] | RouteRequestOptions,
  ): Promise<CalculatedRoute>;

  calculateRoutes?(
    start: Coordinate,
    end: Coordinate,
    options?: RouteRequestOptions,
  ): Promise<CalculatedRoute[]>;
}

export { offlineRoutingAdapter as defaultRoutingAdapter } from './offline-adapter';
