import type { NavigationState } from '../types/navigation';
import type { Coordinate } from '../routing/routing-adapter';
import {
  defaultRoutingAdapter,
  type CalculatedRoute,
  type RoutingAdapter,
} from '../routing/routing-adapter';
import {
  countPassedWaypoints,
  matchPositionToRoute,
  remainingDurationSeconds,
  waypointPositionsAlong,
} from '../routing/route-matcher';
import {
  selectNextInstruction,
  selectNextInstructionIndex,
} from '../routing/turn-instructions';
import { remainingFromProjectionMeters } from '../routing/geo';
import { mapService } from './map.service';
import { offlineRoutingAdapter } from '../routing/offline-adapter';
import type { RoutingProgress } from '../routing/routing-progress';
import {
  loadAllowExpressways,
  saveAllowExpressways,
  type RoutingProfileId,
} from '../routing/routing-profiles';
import {
  calculatedToSavedRoute,
  savedToCalculatedRoute,
  type SavedRoute,
} from '../types/route';
import { suggestRouteName } from '../routing/route-naming';
import { routeLibrary } from './route-library.service';
import { isAbortError } from '../routing/abort';

export type NavigationListener = (state: NavigationState) => void;

export type PlanRouteResult = 'ready' | 'cancelled' | 'error';

const ARRIVE_THRESHOLD_M = 25;
const REROUTE_COOLDOWN_MS = 8_000;
/** Consecutive off-route fixes needed before a reroute (one bad fix is noise). */
const OFF_ROUTE_CONFIRM_FIXES = 2;
/** Fixes worse than this cannot confirm or clear an off-route reading. */
const MAX_TRUSTED_ACCURACY_M = 100;

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
    waypoints: [],
  };
  private waypoints: Coordinate[] = [];
  private route: CalculatedRoute | null = null;
  private alternatives: CalculatedRoute[] = [];
  private lastPosition: Coordinate | null = null;
  private lastAccuracyMeters: number | null = null;
  private offRouteStreak = 0;
  /** Distance along the active route to each remaining waypoint. */
  private waypointAlong: number[] = [];
  private lastRerouteAt = 0;
  private listeners = new Set<NavigationListener>();
  private engineReady = false;
  private profile: RoutingProfileId = 'fastest';
  private allowExpressways = loadAllowExpressways();
  /** Bumped whenever a plan or reroute is replaced or cancelled. */
  private planToken = 0;
  private planAbort: AbortController | null = null;
  /** Dashed rider→destination link while a background plan is in flight. */
  private planningLink: { from: Coordinate; to: Coordinate } | null = null;

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
      if (
        this.state.status === 'navigating' ||
        this.state.status === 'planning' ||
        this.state.status === 'rerouting'
      ) {
        return;
      }
      this.setState({
        ...this.state,
        status: 'idle',
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

  setWaypoints(waypoints: Coordinate[]): void {
    this.waypoints = [...waypoints];
    this.setState({ ...this.state, waypoints: this.waypoints });
  }

  clearItinerary(): void {
    this.invalidateRouting();
    this.waypoints = [];
    this.waypointAlong = [];
    this.route = null;
    this.alternatives = [];
    this.planningLink = null;
    mapService.clearRoute();
    mapService.clearItinerary();
    this.setState({
      status: 'idle',
      destination: undefined,
      waypoints: [],
      profile: this.profile,
      alternatives: [],
      selectedAlternativeIndex: 0,
      showAllRoutes: false,
      offRoute: false,
      currentInstruction: undefined,
      distanceToNextManeuverMeters: undefined,
      remainingDistanceMeters: undefined,
      remainingDurationSeconds: undefined,
      message: 'Tap the map to set a destination',
      progress: undefined,
    });
  }

  /** Banner copy while GPS is resolving, before the road download starts. */
  showPlanning(message: string): void {
    this.setState({
      ...this.state,
      status: 'planning',
      message,
      progress: {
        phase: 'downloading-roads',
        label: message,
        percent: null,
      },
    });
  }

  /**
   * Stop an in-flight preview without dropping a route that already exists.
   * A newer planRoute() invalidates on its own and should not call this.
   */
  cancelPlanning(): void {
    const wasPlanning = this.state.status === 'planning';
    this.invalidateRouting();
    if (!wasPlanning) return;
    this.restoreAfterCancelledPlan();
  }

  setProfile(profile: RoutingProfileId): void {
    this.profile = profile;
    this.setState({ ...this.state, profile });
  }

  getAllowExpressways(): boolean {
    return this.allowExpressways;
  }

  /** Takes effect on the next plan / reroute (callers re-plan). */
  setAllowExpressways(allow: boolean): void {
    this.allowExpressways = allow;
    saveAllowExpressways(allow);
  }

  selectAlternative(index: number): void {
    const route = this.alternatives[index];
    if (!route) return;
    this.setActiveRoute(route);
    mapService.drawAlternatives(
      this.alternatives.map((r) => r.coordinates),
      index,
      this.state.showAllRoutes === true,
    );
    mapService.drawRoute(route.coordinates, index);
    const next = selectNextInstruction(route.instructions, 0);
    this.setState({
      ...this.state,
      status: this.state.status === 'navigating' ? 'navigating' : 'choosing',
      selectedAlternativeIndex: index,
      currentInstruction: next,
      distanceToNextManeuverMeters: next?.distanceMeters,
      remainingDistanceMeters: route.distanceMeters,
      remainingDurationSeconds: route.durationSeconds,
      message: `Selected: ${route.label ?? `Option ${index + 1}`}`,
    });
  }

  /** Enter turn-by-turn navigation for the selected (or given) route. */
  startNavigation(index?: number): void {
    const pick = index ?? this.state.selectedAlternativeIndex ?? 0;
    const route = this.alternatives[pick] ?? this.route;
    if (!route) return;

    this.setActiveRoute(route);
    mapService.drawAlternatives(
      this.alternatives.map((r) => r.coordinates),
      pick,
      false,
    );
    mapService.drawRoute(route.coordinates, pick);
    mapService.fitRoute(route.coordinates);

    const next = selectNextInstruction(route.instructions, 0);
    this.setState({
      ...this.state,
      status: 'navigating',
      selectedAlternativeIndex: pick,
      showAllRoutes: false,
      currentInstruction: next,
      distanceToNextManeuverMeters: next?.distanceMeters,
      remainingDistanceMeters: route.distanceMeters,
      remainingDurationSeconds: route.durationSeconds,
      offRoute: false,
      message: undefined,
      progress: undefined,
    });

    if (this.lastPosition) this.followRoute(this.lastPosition);
  }

  /**
   * Load a previously saved / imported route into choosing mode
   * so the rider can Start navigation without re-planning.
   */
  loadSavedRoute(saved: SavedRoute): void {
    const calculated = savedToCalculatedRoute(saved);
    this.alternatives = [calculated];
    this.waypoints = [...(saved.waypoints ?? [])];
    this.setActiveRoute(calculated);
    if (saved.profile) this.profile = saved.profile;

    mapService.clearAlternatives();
    mapService.setDestination(saved.end);
    mapService.setItineraryStops(
      this.waypoints.map((coordinate, i) => ({
        coordinate,
        kind: 'manual' as const,
        name: `Stop ${i + 1}`,
      })),
    );
    mapService.drawRoute(calculated.coordinates, 0);
    mapService.fitRoute(calculated.coordinates);

    const next = selectNextInstruction(calculated.instructions, 0);
    this.setState({
      status: 'choosing',
      destination: saved.end,
      waypoints: this.waypoints,
      profile: this.profile,
      alternatives: this.alternatives,
      selectedAlternativeIndex: 0,
      showAllRoutes: false,
      currentInstruction: next,
      distanceToNextManeuverMeters: next?.distanceMeters,
      remainingDistanceMeters: calculated.distanceMeters,
      remainingDurationSeconds: calculated.durationSeconds,
      offRoute: false,
      message: `Loaded · ${saved.name}`,
      progress: undefined,
    });
  }

  async saveActiveRoute(name?: string): Promise<SavedRoute> {
    const route = this.getActiveCalculatedRoute();
    if (!route) throw new Error('No route to save');
    const label = name?.trim() || suggestRouteName(route, this.profile);
    return routeLibrary.saveFromCalculated(route, label, {
      start: route.coordinates[0],
      end: this.state.destination ?? route.coordinates[route.coordinates.length - 1],
      waypoints: this.waypoints,
    });
  }

  getActiveCalculatedRoute(): CalculatedRoute | null {
    return (
      this.route ??
      this.alternatives[this.state.selectedAlternativeIndex ?? 0] ??
      null
    );
  }

  buildSavedSnapshot(name?: string): SavedRoute | null {
    const route = this.getActiveCalculatedRoute();
    if (!route) return null;
    const label = name?.trim() || suggestRouteName(route, this.profile);
    return calculatedToSavedRoute(route, label, {
      start: route.coordinates[0],
      end:
        this.state.destination ??
        route.coordinates[route.coordinates.length - 1],
      waypoints: this.waypoints,
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
  ): Promise<PlanRouteResult> {
    const { token, signal } = this.startRoutingJob();

    this.waypoints = waypoints ? [...waypoints] : [];
    this.planningLink = { from: start, to: end };
    mapService.setDestination(end);
    mapService.drawRecalcLink(start, end);
    mapService.setRouteRecalculating(true);
    mapService.clearAlternatives();

    this.setState({
      status: 'planning',
      destination: end,
      waypoints: this.waypoints,
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

    const unsubProgress = this.bindProgress(token);

    try {
      await this.ensureEngine();
      if (token !== this.planToken) return 'cancelled';

      const options = {
        waypoints: this.waypoints,
        profile: this.profile,
        allowExpressways: this.allowExpressways,
        alternatives: this.waypoints.length > 0 ? 1 : 3,
        signal,
      };
      this.alternatives =
        typeof this.adapter.calculateRoutes === 'function'
          ? await this.adapter.calculateRoutes(start, end, options)
          : [await this.adapter.calculateRoute(start, end, options)];

      if (token !== this.planToken) return 'cancelled';

      this.route = this.alternatives[0] ?? null;
      if (!this.route) {
        throw new Error('No routes returned');
      }
      this.setActiveRoute(this.route);

      this.planningLink = null;
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
        status: 'choosing',
        destination: end,
        waypoints: this.waypoints,
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
            ? `${this.alternatives.length} routes — pick one, then Start`
            : this.waypoints.length > 0
              ? `Route ready · ${this.waypoints.length} stop${this.waypoints.length === 1 ? '' : 's'} — tap Start`
              : 'Route ready — tap Start to navigate',
        progress: undefined,
      });
      return 'ready';
    } catch (e) {
      if (token !== this.planToken || isAbortError(e)) return 'cancelled';
      const message =
        e instanceof Error
          ? e.message
          : 'Routing failed — offline engine error';
      this.planningLink = null;
      this.route = null;
      this.alternatives = [];
      mapService.clearRoute();
      this.setState({
        status: 'error',
        destination: end,
        waypoints: this.waypoints,
        profile: this.profile,
        alternatives: [],
        selectedAlternativeIndex: 0,
        offRoute: false,
        message,
        progress: undefined,
      });
      return 'error';
    } finally {
      unsubProgress();
      if (token === this.planToken) this.planAbort = null;
    }
  }

  /**
   * Draw the active plan onto the map. The map unmounts when the rider
   * leaves the Map tab, so a preview that finishes in the background is
   * applied again when the map is ready.
   */
  redrawMap(): void {
    const status = this.state.status;
    if (status === 'planning' || status === 'rerouting') {
      if (!this.planningLink) return;
      mapService.drawRecalcLink(this.planningLink.from, this.planningLink.to);
      mapService.setRouteRecalculating(true);
      return;
    }

    if (!this.route) return;
    if (status !== 'choosing' && status !== 'navigating' && status !== 'paused') {
      return;
    }

    const index = this.state.selectedAlternativeIndex ?? 0;
    const showAll = status === 'choosing' && this.state.showAllRoutes === true;
    mapService.drawAlternatives(
      this.alternatives.map((route) => route.coordinates),
      index,
      showAll,
    );
    mapService.drawRoute(this.route.coordinates, index);
    if (status === 'choosing') {
      mapService.fitRoute(this.route.coordinates);
    }
  }

  updatePosition(position: Coordinate, accuracyMeters?: number | null): void {
    this.lastPosition = position;
    this.lastAccuracyMeters = accuracyMeters ?? null;
    if (!this.route) return;

    if (this.state.status === 'navigating' || this.state.status === 'rerouting') {
      this.followRoute(position);
    }
  }

  /** Make `route` the one being followed and re-anchor the stops on it. */
  private setActiveRoute(route: CalculatedRoute): void {
    this.route = route;
    this.offRouteStreak = 0;
    this.waypointAlong = waypointPositionsAlong(
      this.waypoints,
      route.coordinates,
    );
  }

  private followRoute(position: Coordinate): void {
    const route = this.route;
    if (!route || !this.state.destination) return;

    const accuracy = this.lastAccuracyMeters;
    const match = matchPositionToRoute(position, route.coordinates, {
      accuracyMeters: accuracy,
    });
    const remaining = match.point
      ? remainingFromProjectionMeters(route.coordinates, {
          segmentIndex: match.nearestIndex,
          point: match.point,
        })
      : route.distanceMeters;

    if (
      match.distanceMeters <= ARRIVE_THRESHOLD_M &&
      remaining < ARRIVE_THRESHOLD_M * 2
    ) {
      this.arrive();
      return;
    }

    // A poor fix can neither confirm nor clear an off-route reading.
    if (accuracy == null || accuracy <= MAX_TRUSTED_ACCURACY_M) {
      this.offRouteStreak = match.offRoute ? this.offRouteStreak + 1 : 0;
    }
    const offRoute = this.offRouteStreak >= OFF_ROUTE_CONFIRM_FIXES;

    if (!match.offRoute) this.dropPassedWaypoints(match.alongMeters);

    const step = selectNextInstructionIndex(
      route.instructions,
      match.alongMeters,
    );
    const next = step ? route.instructions[step.index] : undefined;
    const distanceToNext = step
      ? Math.max(0, step.endAlongMeters - match.alongMeters)
      : remaining;
    // Keep 'rerouting' while a recalculation is in flight so its progress stays visible.
    const status =
      this.state.status === 'rerouting' ? 'rerouting' : 'navigating';

    if (offRoute) {
      this.setState({
        ...this.state,
        status,
        waypoints: this.waypoints,
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
      status,
      waypoints: this.waypoints,
      currentInstruction: next,
      distanceToNextManeuverMeters: distanceToNext,
      remainingDistanceMeters: remaining,
      remainingDurationSeconds: remainingDurationSeconds(route, remaining),
      offRoute: false,
      message: status === 'rerouting' ? this.state.message : undefined,
    });
  }

  /** Forget stops the rider has ridden past, so a reroute skips them. */
  private dropPassedWaypoints(alongMeters: number): void {
    const passed = countPassedWaypoints(this.waypointAlong, alongMeters);
    if (passed === 0) return;
    this.waypoints = this.waypoints.slice(passed);
    this.waypointAlong = this.waypointAlong.slice(passed);
  }

  private async tryReroute(position: Coordinate): Promise<void> {
    if (!this.state.destination) return;
    const now = Date.now();
    if (now - this.lastRerouteAt < REROUTE_COOLDOWN_MS) return;
    if (this.state.status === 'rerouting') return;

    this.lastRerouteAt = now;
    const destination = this.state.destination;
    const { token, signal } = this.startRoutingJob();
    const previous = this.route?.coordinates;
    if (previous && previous.length >= 2) {
      mapService.drawGhostRoute(previous);
      mapService.setRouteRecalculating(true);
    }
    this.planningLink = { from: position, to: destination };
    mapService.drawRecalcLink(position, destination);

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

    const unsubProgress = this.bindProgress(token);

    try {
      // followRoute drops stops already ridden past, so these are all ahead.
      const remainingWaypoints = this.waypoints;
      const options = {
        profile: this.profile,
        allowExpressways: this.allowExpressways,
        alternatives: remainingWaypoints.length > 0 ? 1 : 3,
        waypoints: remainingWaypoints,
        signal,
      };
      this.alternatives =
        typeof this.adapter.calculateRoutes === 'function'
          ? await this.adapter.calculateRoutes(position, destination, options)
          : [
              await this.adapter.calculateRoute(position, destination, options),
            ];
      if (token !== this.planToken) return;
      this.planningLink = null;
      this.route = this.alternatives[0] ?? null;
      if (!this.route) throw new Error('No routes returned');
      this.setActiveRoute(this.route);

      mapService.clearGhostRoute();
      mapService.clearRecalcLink();
      mapService.drawAlternatives(
        this.alternatives.map((r) => r.coordinates),
        0,
        false,
      );
      mapService.drawRoute(this.route.coordinates, 0);
      const next = selectNextInstruction(this.route.instructions, 0);
      // Stay in navigation mode after a mid-ride recalculation.
      this.setState({
        status: 'navigating',
        destination: this.state.destination,
        waypoints: this.waypoints,
        profile: this.profile,
        alternatives: this.alternatives,
        selectedAlternativeIndex: 0,
        showAllRoutes: false,
        currentInstruction: next,
        distanceToNextManeuverMeters: next?.distanceMeters,
        remainingDistanceMeters: this.route.distanceMeters,
        remainingDurationSeconds: this.route.durationSeconds,
        offRoute: false,
        message: undefined,
        progress: undefined,
      });
    } catch (e) {
      if (token !== this.planToken || isAbortError(e)) return;
      const message =
        e instanceof Error ? e.message : 'Offline reroute failed';
      this.planningLink = null;
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
      if (token === this.planToken) this.planAbort = null;
    }
  }

  private bindProgress(token: number): () => void {
    return offlineRoutingAdapter.subscribeProgress((progress: RoutingProgress) => {
      if (token !== this.planToken) return;
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

  private invalidateRouting(): void {
    this.planToken += 1;
    this.planAbort?.abort();
    this.planAbort = null;
  }

  private startRoutingJob(): { token: number; signal: AbortSignal } {
    this.invalidateRouting();
    const abort = new AbortController();
    this.planAbort = abort;
    return { token: this.planToken, signal: abort.signal };
  }

  private restoreAfterCancelledPlan(): void {
    this.planningLink = null;
    mapService.clearRecalcLink();
    mapService.setRouteRecalculating(false);
    if (this.route) {
      const index = this.state.selectedAlternativeIndex ?? 0;
      const routes =
        this.alternatives.length > 0 ? this.alternatives : [this.route];
      mapService.drawAlternatives(
        routes.map((route) => route.coordinates),
        index,
        false,
      );
      mapService.drawRoute(this.route.coordinates, index);
      this.setState({
        ...this.state,
        status: 'choosing',
        alternatives: routes,
        progress: undefined,
        message: 'Trip changed — preview again to update the route',
      });
      return;
    }
    this.setState({
      ...this.state,
      status: 'idle',
      alternatives: [],
      progress: undefined,
      message: this.state.destination
        ? 'Destination set — plan a route'
        : 'Tap the map to set a destination',
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
    this.invalidateRouting();
    this.planningLink = null;
    this.route = null;
    this.alternatives = [];
    mapService.clearRoute();
    this.setState({
      status: 'idle',
      destination: this.state.destination,
      waypoints: this.waypoints,
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

export const navigationService = new NavigationService();
