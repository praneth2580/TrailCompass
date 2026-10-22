import type { NavigationState } from '../types/navigation';
import type { Coordinate } from '../routing/routing-adapter';
import {
  defaultRoutingAdapter,
  type CalculatedRoute,
  type RoutingAdapter,
} from '../routing/routing-adapter';
import { matchPositionToRoute } from '../routing/route-matcher';
import { selectNextInstruction } from '../routing/turn-instructions';
import {
  distanceAlongPolylineMeters,
  remainingPolylineMeters,
} from '../routing/geo';
import { mapService } from './map.service';
import { offlineRoutingAdapter } from '../routing/offline-adapter';

export type NavigationListener = (state: NavigationState) => void;

const ARRIVE_THRESHOLD_M = 25;
const REROUTE_COOLDOWN_MS = 8_000;

/**
 * Navigation orchestrator. Route calculation uses RoutingAdapter
 * (offline graph / Valhalla). Never falls back to online routing APIs.
 */
export class NavigationService {
  private adapter: RoutingAdapter;
  private state: NavigationState = {
    status: 'idle',
    offRoute: false,
    message: 'Tap the map to set a destination',
  };
  private route: CalculatedRoute | null = null;
  private lastPosition: Coordinate | null = null;
  private lastRerouteAt = 0;
  private listeners = new Set<NavigationListener>();
  private engineReady = false;

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

  async ensureEngine(): Promise<void> {
    if (this.engineReady) return;
    const status = await offlineRoutingAdapter.initialize();
    this.engineReady = status.ready;
    if (!status.ready) {
      this.setState({
        ...this.state,
        status: this.state.status === 'navigating' ? this.state.status : 'idle',
        message: status.message,
      });
      return;
    }
    if (this.state.status === 'idle') {
      this.setState({
        ...this.state,
        message: `Ready · ${status.label}. Tap map to set destination.`,
      });
    }
  }

  setDestination(destination: Coordinate): void {
    this.setState({
      ...this.state,
      destination,
      message:
        this.state.status === 'navigating'
          ? this.state.message
          : 'Destination set — plan a route',
    });
  }

  async planRoute(
    start: Coordinate,
    end: Coordinate,
    waypoints?: Coordinate[],
  ): Promise<void> {
    await this.ensureEngine();

    this.setState({
      status: 'planning',
      destination: end,
      offRoute: false,
      message: 'Loading roads and calculating route…',
    });

    try {
      this.route = await this.adapter.calculateRoute(start, end, waypoints);
      mapService.drawRoute(this.route.coordinates);
      mapService.fitRoute(this.route.coordinates);

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
          : 'Routing failed — offline engine error';
      this.route = null;
      mapService.clearRoute();
      this.setState({
        status: 'error',
        destination: end,
        offRoute: false,
        message,
      });
    }
  }

  updatePosition(position: Coordinate): void {
    this.lastPosition = position;
    if (!this.route) return;

    if (this.state.status === 'navigating' || this.state.status === 'rerouting') {
      this.followRoute(position);
    }
  }

  private followRoute(position: Coordinate): void {
    if (!this.route || !this.state.destination) return;

    const along = distanceAlongPolylineMeters(position, this.route.coordinates);
    const match = matchPositionToRoute(position, this.route.coordinates);
    const remaining = remainingPolylineMeters(
      this.route.coordinates,
      Math.max(0, along.nearestIndex),
    );

    if (
      match.distanceMeters <= ARRIVE_THRESHOLD_M &&
      remaining < ARRIVE_THRESHOLD_M * 2
    ) {
      this.arrive();
      return;
    }

    const next = selectNextInstruction(
      this.route.instructions,
      along.alongMeters,
    );

    const distanceToNext = next
      ? Math.max(
          0,
          distanceToInstructionEnd(along.alongMeters, next, this.route),
        )
      : remaining;

    if (match.offRoute) {
      this.setState({
        ...this.state,
        status: 'navigating',
        currentInstruction: next,
        distanceToNextManeuverMeters: distanceToNext,
        remainingDistanceMeters: remaining,
        offRoute: true,
        message: 'Off route — recalculating…',
      });
      void this.tryReroute(position);
      return;
    }

    this.setState({
      ...this.state,
      status: 'navigating',
      currentInstruction: next,
      distanceToNextManeuverMeters: distanceToNext,
      remainingDistanceMeters: remaining,
      remainingDurationSeconds: Math.round(remaining / 11),
      offRoute: false,
      message: undefined,
    });
  }

  private async tryReroute(position: Coordinate): Promise<void> {
    if (!this.state.destination) return;
    const now = Date.now();
    if (now - this.lastRerouteAt < REROUTE_COOLDOWN_MS) return;
    if (this.state.status === 'rerouting') return;

    this.lastRerouteAt = now;
    this.setState({
      ...this.state,
      status: 'rerouting',
      offRoute: true,
      message: 'Rerouting offline…',
    });

    try {
      this.route = await this.adapter.calculateRoute(
        position,
        this.state.destination,
      );
      mapService.drawRoute(this.route.coordinates);
      const next = selectNextInstruction(this.route.instructions, 0);
      this.setState({
        status: 'navigating',
        destination: this.state.destination,
        currentInstruction: next,
        distanceToNextManeuverMeters: next?.distanceMeters,
        remainingDistanceMeters: this.route.distanceMeters,
        remainingDurationSeconds: this.route.durationSeconds,
        offRoute: false,
        message: undefined,
      });
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'Offline reroute failed';
      this.setState({
        ...this.state,
        status: 'navigating',
        offRoute: true,
        message: `Still off route — ${message}`,
      });
    }
  }

  private arrive(): void {
    mapService.clearRoute();
    this.route = null;
    this.setState({
      status: 'arrived',
      destination: this.state.destination,
      offRoute: false,
      remainingDistanceMeters: 0,
      message: 'Arrived',
    });
  }

  pause(): void {
    if (this.state.status !== 'navigating') return;
    this.setState({ ...this.state, status: 'paused', message: 'Navigation paused' });
  }

  resume(): void {
    if (this.state.status !== 'paused') return;
    this.setState({ ...this.state, status: 'navigating', message: undefined });
    if (this.lastPosition) this.followRoute(this.lastPosition);
  }

  stop(): void {
    this.route = null;
    mapService.clearRoute();
    this.setState({
      status: 'idle',
      destination: this.state.destination,
      offRoute: false,
      currentInstruction: undefined,
      distanceToNextManeuverMeters: undefined,
      remainingDistanceMeters: undefined,
      remainingDurationSeconds: undefined,
      message: this.state.destination
        ? 'Stopped — plan again when ready'
        : 'Tap the map to set a destination',
    });
  }

  private setState(state: NavigationState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function distanceToInstructionEnd(
  alongMeters: number,
  instruction: { distanceMeters: number; text: string },
  route: CalculatedRoute,
): number {
  let cumulative = 0;
  for (const step of route.instructions) {
    cumulative += step.distanceMeters;
    if (
      step.text === instruction.text &&
      step.distanceMeters === instruction.distanceMeters
    ) {
      return Math.max(0, cumulative - alongMeters);
    }
  }
  return instruction.distanceMeters;
}

export const navigationService = new NavigationService();
