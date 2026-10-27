import type { Coordinate } from '../routing/routing-adapter';
import { distanceAlongPolylineMeters } from '../routing/geo';
import {
  createTripStop,
  type StopKind,
  type TripStop,
} from '../types/trip-stop';
import type { SavedPlaces } from '../types/route';

export interface TripPlannerState {
  destination: TripStop | null;
  /** Intermediate stops in visit order (before destination). */
  stops: TripStop[];
  /** When set, Map tab is waiting for a single tap to place a stop. */
  mapPick: MapPickRequest | null;
}

export interface MapPickRequest {
  kind: StopKind;
  /** Replace destination vs append intermediate stop. */
  mode: 'destination' | 'stop';
  replaceStopId?: string;
}

export type TripPlannerListener = (state: TripPlannerState) => void;

/**
 * List-first itinerary for the Plan tab.
 * Coordinates feed into NavigationService.planRoute as waypoints.
 */
export class TripPlannerService {
  private state: TripPlannerState = {
    destination: null,
    stops: [],
    mapPick: null,
  };
  private listeners = new Set<TripPlannerListener>();

  getState(): TripPlannerState {
    return this.state;
  }

  subscribe(listener: TripPlannerListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  setDestination(stop: TripStop): void {
    this.setState({
      ...this.state,
      destination: { ...stop, kind: 'destination' },
      mapPick: null,
    });
  }

  setDestinationFromCoordinate(
    coordinate: Coordinate,
    name?: string,
  ): void {
    this.setDestination(
      createTripStop('destination', coordinate, name ?? 'Destination'),
    );
  }

  clearDestination(): void {
    this.setState({ ...this.state, destination: null });
  }

  addStop(stop: TripStop, routeGuide?: Coordinate[] | null): void {
    if (stop.kind === 'destination') {
      this.setDestination(stop);
      return;
    }
    const stops = routeGuide && routeGuide.length >= 2
      ? insertByRouteProgress(this.state.stops, stop, routeGuide)
      : [...this.state.stops, stop];
    this.setState({
      ...this.state,
      stops,
      mapPick: null,
    });
  }

  updateStop(id: string, patch: Partial<TripStop>): void {
    if (this.state.destination?.id === id) {
      this.setState({
        ...this.state,
        destination: { ...this.state.destination, ...patch, id },
      });
      return;
    }
    this.setState({
      ...this.state,
      stops: this.state.stops.map((s) =>
        s.id === id ? { ...s, ...patch, id } : s,
      ),
    });
  }

  removeStop(id: string): void {
    if (this.state.destination?.id === id) {
      this.clearDestination();
      return;
    }
    this.setState({
      ...this.state,
      stops: this.state.stops.filter((s) => s.id !== id),
    });
  }

  moveStop(id: string, direction: -1 | 1): void {
    const index = this.state.stops.findIndex((s) => s.id === id);
    if (index < 0) return;
    const next = index + direction;
    if (next < 0 || next >= this.state.stops.length) return;
    const stops = [...this.state.stops];
    const [item] = stops.splice(index, 1);
    stops.splice(next, 0, item!);
    this.setState({ ...this.state, stops });
  }

  clear(): void {
    this.setState({ destination: null, stops: [], mapPick: null });
  }

  beginMapPick(request: MapPickRequest): void {
    this.setState({ ...this.state, mapPick: request });
  }

  cancelMapPick(): void {
    if (!this.state.mapPick) return;
    this.setState({ ...this.state, mapPick: null });
  }

  /**
   * Apply a map tap while map-pick mode is active.
   * Returns true if the pick was consumed.
   */
  completeMapPick(coordinate: Coordinate, name?: string): boolean {
    const pick = this.state.mapPick;
    if (!pick) return false;

    if (pick.mode === 'destination') {
      this.setDestinationFromCoordinate(coordinate, name ?? 'Destination');
      return true;
    }

    if (pick.replaceStopId) {
      this.updateStop(pick.replaceStopId, {
        coordinate,
        name: name ?? undefined,
        kind: pick.kind === 'destination' ? 'manual' : pick.kind,
      });
      this.setState({ ...this.getState(), mapPick: null });
      return true;
    }

    this.addStop(
      createTripStop(
        pick.kind === 'destination' ? 'manual' : pick.kind,
        coordinate,
        name ?? '',
      ),
    );
    return true;
  }

  /** Waypoints between start and final destination. */
  getWaypoints(): Coordinate[] {
    return this.state.stops.map((s) => s.coordinate);
  }

  getDestinationCoordinate(): Coordinate | null {
    return this.state.destination?.coordinate ?? null;
  }

  canPlan(): boolean {
    return this.state.destination != null;
  }

  /** A saved trip's destination and stops, with their names when it kept them. */
  loadFromSaved(end: Coordinate, waypoints: Coordinate[] = [], places?: SavedPlaces): void {
    const named = places?.stops?.length === waypoints.length ? places.stops : undefined;
    const stops = waypoints.map((c, i) =>
      named
        ? createTripStop(named[i]!.kind, c, named[i]!.name, named[i]!.notes)
        : createTripStop('manual', c, `Stop ${i + 1}`),
    );
    this.setState({
      destination: createTripStop('destination', end, places?.end ?? 'Destination', places?.endNotes),
      stops,
      mapPick: null,
    });
  }

  private setState(state: TripPlannerState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function insertByRouteProgress(
  existing: TripStop[],
  stop: TripStop,
  route: Coordinate[],
): TripStop[] {
  const stopAlong = distanceAlongPolylineMeters(
    stop.coordinate,
    route,
  ).alongMeters;
  const next = [...existing];
  let insertAt = next.length;
  for (let i = 0; i < next.length; i++) {
    const along = distanceAlongPolylineMeters(
      next[i]!.coordinate,
      route,
    ).alongMeters;
    if (stopAlong < along) {
      insertAt = i;
      break;
    }
  }
  next.splice(insertAt, 0, stop);
  return next;
}

export const tripPlanner = new TripPlannerService();
