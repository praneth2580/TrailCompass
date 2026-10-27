import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import type { NavigationState } from '../types/navigation';
import { Downloads, type DownloadAction, type DownloadNotice } from './downloads-plugin';
import { navigationService, type PlanRouteResult } from './navigation.service';
import { tripPlanner } from './trip-planner.service';

/** Android drops notification updates that come faster than this. */
const UPDATE_EVERY_MS = 1_000;

type Phase = 'off' | 'running' | 'paused';

/**
 * "Run in background" for route planning. A foreground service keeps the
 * app alive and shows the progress in a notification with Pause, Resume
 * and Stop; the planning itself carries on in the web view as usual.
 */
export class BackgroundPlanningService {
  private phase: Phase = 'off';
  private cleanups: Array<() => void> = [];
  private lastSentAt = 0;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();

  /** The notification service is part of the Android app. */
  isAvailable(): boolean {
    return Capacitor.getPlatform() === 'android';
  }

  isActive(): boolean {
    return this.phase !== 'off';
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Show the notification and send the app to the background. False if
   * planning ended first or the service could not start.
   */
  async start(): Promise<boolean> {
    if (this.phase !== 'off' || !navigationService.isPlanningRoute()) return false;
    // Android 13+ asks once. Without permission planning still runs; only
    // the notification is hidden.
    await Downloads.requestNotifications().catch(() => undefined);
    if (!navigationService.isPlanningRoute()) return false;

    this.phase = 'running';
    // Before any await, so a plan that settles meanwhile is not missed.
    this.cleanups.push(navigationService.onPlanSettled((result) => this.onSettled(result)));
    try {
      const actions = await Downloads.addListener('action', ({ action }) =>
        this.onAction(action),
      );
      this.cleanups.push(() => void actions.remove());
      // The plan may have settled during the awaits.
      if (!this.isActive()) {
        void actions.remove();
        return false;
      }
      this.lastSentAt = Date.now();
      await Downloads.startService(this.progressNotice(navigationService.getState()));
    } catch {
      this.teardown();
      return false;
    }
    if (!this.isActive()) return false;

    this.cleanups.push(navigationService.subscribe((state) => this.onState(state)));
    this.emit();
    void CapacitorApp.minimizeApp();
    return true;
  }

  private onState(state: NavigationState): void {
    // Endings arrive through onSettled; this only tracks progress.
    if (this.phase === 'off' || state.status !== 'planning') return;
    if (this.phase === 'paused') {
      // Planned again from the app: carry on in the background.
      this.phase = 'running';
      this.emit();
    }
    this.queue(this.progressNotice(state));
  }

  private onSettled(result: PlanRouteResult): void {
    // While paused, the cancelled plan is the pause itself.
    if (this.phase !== 'running') return;
    if (result === 'ready') this.finish(true);
    else if (result === 'error') this.finish(false);
    // Cancelled: a newer plan took over (still planning), or the app stopped it.
    else if (navigationService.getState().status !== 'planning') this.end();
  }

  private onAction(action: DownloadAction): void {
    if (this.phase === 'off') return;
    if (action === 'stop') {
      // The service has already removed the notification.
      this.teardown();
      navigationService.cancelPlanning();
      return;
    }
    if (action === 'pause' && this.phase === 'running') {
      this.phase = 'paused';
      navigationService.pausePlanning();
      this.send({
        title: 'Route planning paused',
        text: 'Roads downloaded so far are kept',
        paused: true,
      });
      this.emit();
    } else if (action === 'resume' && this.phase === 'paused') {
      this.phase = 'running';
      this.send({ title: this.title(), text: 'Resuming…', percent: null });
      this.emit();
      if (!navigationService.resumePlanning()) this.end();
    }
  }

  private finish(ok: boolean): void {
    const state = navigationService.getState();
    const name = tripPlanner.getState().destination?.name;
    const notice = ok
      ? {
          title: name ? `Route to ${name} is ready` : 'Your route is ready',
          text: routeSummary(state),
        }
      : {
          title: "Couldn't plan the route",
          text: state.message ?? 'Open TrailCompass to try again',
        };
    // The rider is looking at the app already: it shows the result.
    const notify = typeof document === 'undefined' || document.visibilityState !== 'visible';
    void Downloads.finish({ ...notice, ok, notify }).catch(() => undefined);
    this.teardown();
  }

  private end(): void {
    void Downloads.stopService().catch(() => undefined);
    this.teardown();
  }

  private teardown(): void {
    clearTimeout(this.pending);
    this.pending = undefined;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.phase = 'off';
    this.emit();
  }

  private progressNotice(state: NavigationState): DownloadNotice {
    return {
      title: this.title(),
      text: state.progress?.label || state.message || 'Downloading roads…',
      percent: state.progress?.percent ?? null,
    };
  }

  private title(): string {
    const name = tripPlanner.getState().destination?.name;
    return name ? `Planning route to ${name}` : 'Planning your route';
  }

  /** At most one update a second; the latest one wins. */
  private queue(notice: DownloadNotice): void {
    clearTimeout(this.pending);
    const wait = this.lastSentAt + UPDATE_EVERY_MS - Date.now();
    if (wait <= 0) this.send(notice);
    else this.pending = setTimeout(() => this.send(notice), wait);
  }

  private send(notice: DownloadNotice): void {
    clearTimeout(this.pending);
    this.pending = undefined;
    this.lastSentAt = Date.now();
    void Downloads.update(notice).catch(() => undefined);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function routeSummary(state: NavigationState): string {
  const parts: string[] = [];
  const meters = state.remainingDistanceMeters;
  const seconds = state.remainingDurationSeconds;
  if (meters != null) parts.push(`${Math.round(meters / 1000)} km`);
  if (seconds != null) {
    const minutes = Math.round(seconds / 60);
    parts.push(minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`);
  }
  const routes = state.alternatives?.length ?? 0;
  if (routes > 1) parts.push(`${routes} routes to pick from`);
  parts.push('tap to open');
  return parts.join(' · ');
}

export const backgroundPlanning = new BackgroundPlanningService();
