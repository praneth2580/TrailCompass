import type {
  CalculatedRoute,
  Coordinate,
  TurnInstruction,
} from '../routing/routing-adapter';
import type { RoutingProgress } from '../routing/routing-progress';
import type { RoutingProfileId } from '../routing/routing-profiles';

export type NavigationStatus =
  | 'idle'
  | 'planning'
  | 'navigating'
  | 'rerouting'
  | 'arrived'
  | 'paused'
  | 'error';

export interface GpsFix {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  altitudeMeters: number | null;
  speedMps: number | null;
  /** Course over ground in degrees, when moving. */
  headingDegrees: number | null;
  timestampMs: number;
}

export interface CompassReading {
  /** Magnetic heading in degrees (0 = north), if available. */
  headingDegrees: number | null;
  accuracy: 'high' | 'medium' | 'low' | 'unreliable' | 'unavailable';
  needsCalibration: boolean;
  message?: string;
  timestampMs: number;
}

export interface NavigationState {
  status: NavigationStatus;
  destination?: Coordinate;
  currentInstruction?: TurnInstruction;
  distanceToNextManeuverMeters?: number;
  remainingDistanceMeters?: number;
  remainingDurationSeconds?: number;
  offRoute: boolean;
  message?: string;
  /** Present while planning/rerouting; percent only when realistically known. */
  progress?: RoutingProgress;
  profile?: RoutingProfileId;
  alternatives?: CalculatedRoute[];
  selectedAlternativeIndex?: number;
  /** When true, every alternative is drawn vividly on the map. */
  showAllRoutes?: boolean;
}
