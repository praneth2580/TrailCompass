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
import type { RoutingProgress } from '../routing/routing-progress';
import type { RoutingProfileId } from '../routing/routing-profiles';

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
    profile: 'fastest',
    alternatives: [],
    selectedAlternativeIndex: 0,
    showAllRoutes: false,
  };
  private route: CalculatedRoute | null = null;
  private alternatives: CalculatedRoute[] = [];
  private lastPosition: Coordinate | null = null;
  private lastRerouteAt = 0;
  private listeners = new Set<NavigationListener>();
  private engineReady = false;
  private profile: RoutingProfileId = 'fastest';

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

  setProfile(profile: RoutingProfileId): void {
    this.profile = profile;
    this.setState({ ...this.state, profile });
  }

  selectAlternative(index: number): void {
    const route = this.alternatives[index];
    if (!route) return;
    this.route = route;
    mapService.drawAlternatives(
      this.alternatives.map((r) => r.coordinates),
      index,
      this.state.showAllRoutes === true,
    );
    mapService.drawRoute(route.coordinates, index);
    const next = selectNextInstruction(route.instructions, 0);
    this.setState({
      ...this.state,
      selectedAlternativeIndex: index,
      currentInstruction: next,
      distanceToNextManeuverMeters: next?.distanceMeters,
      remainingDistanceMeters: route.distanceMeters,
      remainingDurationSeconds: route.durationSeconds,
      message: `Taking: ${route.label ?? `Option ${index + 1}`}`,
    });
  }

  setShowAllRoutes(showAll: boolean): void {
    mapService.drawAlternatives(
      this.alternatives.map((r) => r.coordinates),
      this.state.selectedAlternativeIndex ?? 0,
      showAll,
    );
    if (this.route) {
      mapService.drawRoute(
        this.route.coordinates,
        this.state.selectedAlternativeIndex ?? 0,
      );
    }
    this.setState({ ...this.state, showAllRoutes: showAll });
  }

  async planRoute(
    start: Coordinate,
    end: Coordinate,
    waypoints?: Coordinate[],
  ): Promise<void> {
    await this.ensureEngine();

    mapService.drawRecalcLink(start, end);
    mapService.setRouteRecalculating(true);
    mapService.clearAlternatives();

    this.setState({
      status: 'planning',
      destination: end,
      offRoute: false,
      profile: this.profile,
      alternatives: [],
      selectedAlternativeIndex: 0,
      message: 'Loading roads and calculating route…',
      progress: {
        phase: 'downloading-roads',
        label: 'Preparing route…',
        percent: null,
      },
    });

    const unsubProgress = this.bindProgress();

    try {
      const options = {
        waypoints,
        profile: this.profile,
        alternatives: 3,
      };
      this.alternatives =
        typeof this.adapter.calculateRoutes === 'function'
          ? await this.adapter.calculateRoutes(start, end, options)
          : [await this.adapter.calculateRoute(start, end, options)];

      this.route = this.alternatives[0] ?? null;
      if (!this.route) {
        throw new Error('No routes returned');
      }

      mapService.clearRecalcLink();
      mapService.clearGhostRoute();
      const showAll = this.alternatives.length > 1;
      mapService.drawAlternatives(
        this.alternatives.map((r) => r.coordinates),
        0,
        showAll,
      );
      mapService.drawRoute(this.route.coordinates, 0);
      if (!showAll) {
        mapService.fitRoute(this.route.coordinates);
      }

      const next = selectNextInstruction(this.route.instructions, 0);
      this.setState({
        status: 'navigating',
        destination: end,
        profile: this.profile,
        alternatives: this.alternatives,
        selectedAlternativeIndex: 0,
        showAllRoutes: showAll,
        currentInstruction: next,
        distanceToNextManeuverMeters: next?.distanceMeters,
        remainingDistanceMeters: this.route.distanceMeters,
        remainingDurationSeconds: this.route.durationSeconds,
        offRoute: false,
        message:
          this.alternatives.length > 1
            ? `${this.alternatives.length} routes found — tap a card or map line to choose`
            : undefined,
        progress: undefined,
      });
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : 'Routing failed — offline engine error';
      this.route = null;
      this.alternatives = [];
      mapService.clearRoute();
      this.setState({
        status: 'error',
        destination: end,
        profile: this.profile,
        alternatives: [],
        selectedAlternativeIndex: 0,
        offRoute: false,
        message,
        progress: undefined,
      });
    } finally {
      unsubProgress();
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
    const previous = this.route?.coordinates;
    if (previous && previous.length >= 2) {
      mapService.drawGhostRoute(previous);
      mapService.setRouteRecalculating(true);
    }
    mapService.drawRecalcLink(position, this.state.destination);

    this.setState({
      ...this.state,
      status: 'rerouting',
      offRoute: true,
      message: 'Recalculating on roads…',
      progress: {
        phase: 'downloading-roads',
        label: 'Recalculating…',
        percent: null,
      },
    });

    const unsubProgress = this.bindProgress();

    try {
      const options = { profile: this.profile, alternatives: 3 };
      this.alternatives =
        typeof this.adapter.calculateRoutes === 'function'
          ? await this.adapter.calculateRoutes(
              position,
              this.state.destination,
              options,
            )
          : [
              await this.adapter.calculateRoute(
                position,
                this.state.destination,
                options,
              ),
            ];
      this.route = this.alternatives[0] ?? null;
      if (!this.route) throw new Error('No routes returned');

      mapService.clearGhostRoute();
      mapService.clearRecalcLink();
      const showAll = this.alternatives.length > 1;
      mapService.drawAlternatives(
        this.alternatives.map((r) => r.coordinates),
        0,
        showAll,
      );
      mapService.drawRoute(this.route.coordinates, 0);
      const next = selectNextInstruction(this.route.instructions, 0);
      this.setState({
        status: 'navigating',
        destination: this.state.destination,
        profile: this.profile,
        alternatives: this.alternatives,
        selectedAlternativeIndex: 0,
        showAllRoutes: showAll,
        currentInstruction: next,
        distanceToNextManeuverMeters: next?.distanceMeters,
        remainingDistanceMeters: this.route.distanceMeters,
        remainingDurationSeconds: this.route.durationSeconds,
        offRoute: false,
        message: undefined,
        progress: undefined,
      });
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'Offline reroute failed';
      mapService.clearRecalcLink();
      mapService.setRouteRecalculating(false);
      // Keep ghost of previous path so the rider still sees something.
      this.setState({
        ...this.state,
        status: 'navigating',
        offRoute: true,
        message: `Still off route — ${message}`,
        progress: undefined,
      });
    } finally {
      unsubProgress();
    }
  }

  private bindProgress(): () => void {
    return offlineRoutingAdapter.subscribeProgress((progress: RoutingProgress) => {
      if (
        this.state.status !== 'planning' &&
        this.state.status !== 'rerouting'
      ) {
        return;
      }
      this.setState({
        ...this.state,
        progress,
        message: progress.label || this.state.message,
      });
    });
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
    this.alternatives = [];
    mapService.clearRoute();
    this.setState({
      status: 'idle',
      destination: this.state.destination,
      profile: this.profile,
      alternatives: [],
      selectedAlternativeIndex: 0,
      showAllRoutes: false,
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
