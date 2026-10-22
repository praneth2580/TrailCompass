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

/**
 * Stub adapter: offline routing engine is not wired yet.
 * Does not call any online routing API.
 */
export class OfflineRoutingPendingAdapter implements RoutingAdapter {
  async calculateRoute(
    _start: Coordinate,
    _end: Coordinate,
    _waypoints?: Coordinate[],
  ): Promise<CalculatedRoute> {
    throw new Error(
      'Routing not implemented — offline engine pending. ' +
        'No online routing fallback is used.',
    );
  }
}

export const defaultRoutingAdapter: RoutingAdapter =
  new OfflineRoutingPendingAdapter();
