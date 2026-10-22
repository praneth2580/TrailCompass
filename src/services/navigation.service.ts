import type { NavigationState } from '../types/navigation';
import type { Coordinate } from '../routing/routing-adapter';
import {
  defaultRoutingAdapter,
  type CalculatedRoute,
  type RoutingAdapter,
} from '../routing/routing-adapter';
import { matchPositionToRoute } from '../routing/route-matcher';
import { selectNextInstruction } from '../routing/turn-instructions';

export type NavigationListener = (state: NavigationState) => void;

/**
 * Navigation orchestrator. Route calculation uses RoutingAdapter;
 * the default stub refuses online fallbacks until an offline engine is wired.
 */
export class NavigationService {
  private adapter: RoutingAdapter;
  private state: NavigationState = {
    status: 'idle',
    offRoute: false,
    message: 'Navigation idle — offline routing engine pending',
  };
  private route: CalculatedRoute | null = null;
  private listeners = new Set<NavigationListener>();

  constructor(adapter: RoutingAdapter = defaultRoutingAdapter) {
    this.adapter = adapter;
  }

  getState(): NavigationState {
    return this.state;
  }

  getActiveRoute(): CalculatedRoute | null {
    return this.route;
  }

  subscribe(listener: NavigationListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async planRoute(
    start: Coordinate,
    end: Coordinate,
    waypoints?: Coordinate[],
  ): Promise<void> {
    this.setState({
      status: 'planning',
      destination: end,
      offRoute: false,
      message: 'Calculating route…',
    });

    try {
      this.route = await this.adapter.calculateRoute(start, end, waypoints);
      const next = selectNextInstruction(this.route.instructions, 0);
      this.setState({
        status: 'navigating',
        destination: end,
        currentInstruction: next,
        distanceToNextManeuverMeters: next?.distanceMeters,
        remainingDistanceMeters: this.route.distanceMeters,
        remainingDurationSeconds: this.route.durationSeconds,
        offRoute: false,
        message: undefined,
      });
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : 'Routing failed — offline engine pending';
      this.route = null;
      this.setState({
        status: 'error',
        destination: end,
        offRoute: false,
        message,
      });
    }
  }

  updatePosition(position: Coordinate): void {
    if (!this.route || this.state.status !== 'navigating') return;

    const match = matchPositionToRoute(position, this.route.coordinates);
    const next = selectNextInstruction(
      this.route.instructions,
      match.nearestIndex >= 0 ? match.nearestIndex * 10 : 0,
    );

    this.setState({
      ...this.state,
      currentInstruction: next,
      distanceToNextManeuverMeters: next?.distanceMeters,
      offRoute: match.offRoute,
      message: match.offRoute
        ? 'Off route — offline rerouting not available yet'
        : undefined,
    });
  }

  pause(): void {
    if (this.state.status !== 'navigating') return;
    this.setState({ ...this.state, status: 'paused', message: 'Navigation paused' });
  }

  resume(): void {
    if (this.state.status !== 'paused') return;
    this.setState({ ...this.state, status: 'navigating', message: undefined });
  }

  stop(): void {
    this.route = null;
    this.setState({
      status: 'idle',
      offRoute: false,
      message: 'Navigation stopped',
    });
  }

  private setState(state: NavigationState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

export const navigationService = new NavigationService();
