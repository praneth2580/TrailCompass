import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavigationState } from '../types/navigation';

const native = vi.hoisted(() => ({
  action: null as null | ((event: { action: 'pause' | 'resume' | 'stop' }) => void),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android' },
}));

vi.mock('@capacitor/app', () => ({
  App: { minimizeApp: vi.fn(async () => undefined) },
}));

vi.mock('./downloads-plugin', () => ({
  Downloads: {
    requestNotifications: vi.fn(async () => ({ granted: true })),
    startService: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
    stopService: vi.fn(async () => undefined),
    addListener: vi.fn(async (_event: string, listener: typeof native.action) => {
      native.action = listener;
      return { remove: async () => undefined };
    }),
  },
}));

/** Just enough of NavigationService: its state, and the plan settling. */
const nav = vi.hoisted(() => {
  const listeners = new Set<(state: NavigationState) => void>();
  const settled = new Set<(result: string) => void>();
  return {
    state: {} as NavigationState,
    planning: true,
    listeners,
    settled,
    show(state: Partial<NavigationState>) {
      this.state = { ...this.state, ...state } as NavigationState;
      for (const listener of [...listeners]) listener(this.state);
    },
    settle(result: string) {
      for (const listener of [...settled]) listener(result);
    },
  };
});

vi.mock('./navigation.service', () => ({
  navigationService: {
    getState: () => nav.state,
    isPlanningRoute: () => nav.planning,
    subscribe: (listener: (state: NavigationState) => void) => {
      nav.listeners.add(listener);
      listener(nav.state);
      return () => nav.listeners.delete(listener);
    },
    onPlanSettled: (listener: (result: string) => void) => {
      nav.settled.add(listener);
      return () => nav.settled.delete(listener);
    },
    pausePlanning: vi.fn(),
    resumePlanning: vi.fn(() => Promise.resolve('ready')),
    cancelPlanning: vi.fn(),
  },
}));

vi.mock('./trip-planner.service', () => ({
  tripPlanner: { getState: () => ({ destination: { name: 'Ganpatipule' }, stops: [] }) },
}));

const { App } = await import('@capacitor/app');
const { Downloads } = await import('./downloads-plugin');
const { navigationService } = await import('./navigation.service');
const { BackgroundPlanningService } = await import('./background-planning.service');

function planning(label: string, percent: number | null = null): Partial<NavigationState> {
  return { status: 'planning', progress: { phase: 'downloading-roads', label, percent } };
}

async function started() {
  const background = new BackgroundPlanningService();
  expect(await background.start()).toBe(true);
  return background;
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.listeners.clear();
  nav.settled.clear();
  nav.planning = true;
  nav.state = { status: 'planning', offRoute: false, ...planning('Loading major roads · 2/20 areas', 10) };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BackgroundPlanningService', () => {
  it('shows the progress in a notification and leaves the app', async () => {
    const background = await started();

    expect(Downloads.requestNotifications).toHaveBeenCalled();
    expect(Downloads.startService).toHaveBeenCalledWith({
      title: 'Planning route to Ganpatipule',
      text: 'Loading major roads · 2/20 areas',
      percent: 10,
    });
    expect(App.minimizeApp).toHaveBeenCalled();
    expect(background.isActive()).toBe(true);
  });

  it('does nothing while GPS is still resolving', async () => {
    nav.planning = false;
    expect(await new BackgroundPlanningService().start()).toBe(false);
    expect(Downloads.startService).not.toHaveBeenCalled();
  });

  it('updates the notification at most once a second, with the latest progress', async () => {
    vi.useFakeTimers();
    await started();
    vi.mocked(Downloads.update).mockClear();

    nav.show(planning('Loading major roads · 3/20 areas', 15));
    nav.show(planning('Loading major roads · 4/20 areas', 20));
    expect(Downloads.update).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(Downloads.update).toHaveBeenCalledTimes(1);
    expect(Downloads.update).toHaveBeenCalledWith({
      title: 'Planning route to Ganpatipule',
      text: 'Loading major roads · 4/20 areas',
      percent: 20,
    });
  });

  it('says when the route is ready', async () => {
    const background = await started();
    nav.show({
      status: 'choosing',
      remainingDistanceMeters: 331_400,
      remainingDurationSeconds: 7 * 3600 + 25 * 60,
      alternatives: [],
    });
    nav.settle('ready');

    expect(Downloads.finish).toHaveBeenCalledWith({
      title: 'Route to Ganpatipule is ready',
      text: '331 km · 7 h 25 min · tap to open',
      ok: true,
      notify: true,
    });
    expect(background.isActive()).toBe(false);
  });

  it('pauses and resumes from the notification', async () => {
    const background = await started();

    native.action?.({ action: 'pause' });
    expect(navigationService.pausePlanning).toHaveBeenCalled();
    expect(Downloads.update).toHaveBeenLastCalledWith({
      title: 'Route planning paused',
      text: 'Roads downloaded so far are kept',
      paused: true,
    });
    // The pause itself cancels the running plan.
    nav.show({ status: 'idle', progress: undefined });
    nav.settle('cancelled');
    expect(Downloads.stopService).not.toHaveBeenCalled();
    expect(background.isActive()).toBe(true);

    native.action?.({ action: 'resume' });
    expect(navigationService.resumePlanning).toHaveBeenCalled();
    expect(Downloads.update).toHaveBeenLastCalledWith({
      title: 'Planning route to Ganpatipule',
      text: 'Resuming…',
      percent: null,
    });
  });

  it('stops planning from the notification', async () => {
    const background = await started();
    native.action?.({ action: 'stop' });

    expect(navigationService.cancelPlanning).toHaveBeenCalled();
    expect(background.isActive()).toBe(false);
  });

  it('removes the notification when the plan is cancelled in the app', async () => {
    const background = await started();
    nav.show({ status: 'idle', progress: undefined });
    nav.settle('cancelled');

    expect(Downloads.stopService).toHaveBeenCalled();
    expect(background.isActive()).toBe(false);
  });

  it('keeps going when a newer plan replaces the running one', async () => {
    const background = await started();
    nav.show(planning('Preparing route…'));
    nav.settle('cancelled');

    expect(Downloads.stopService).not.toHaveBeenCalled();
    expect(background.isActive()).toBe(true);
  });
});
