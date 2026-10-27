import { describe, expect, it, vi } from 'vitest';

type WatchCallback = (
  position: { coords: Record<string, number | null>; timestamp: number } | null,
  err?: { message: string },
) => void;

const geo = vi.hoisted(() => ({ watch: null as WatchCallback | null }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock('@capacitor/geolocation', () => ({
  Geolocation: {
    checkPermissions: async () => ({ location: 'granted' }),
    requestPermissions: async () => ({ location: 'granted' }),
    watchPosition: async (_options: unknown, callback: WatchCallback) => {
      geo.watch = callback;
      return 'watch-1';
    },
    clearWatch: async () => undefined,
  },
}));

vi.stubGlobal('window', globalThis);

const { LocationService } = await import('./location.service');

function position(ageMs: number, latitude = 19.1) {
  return {
    coords: { latitude, longitude: 72.85, accuracy: 6 },
    timestamp: Date.now() - ageMs,
  };
}

describe('LocationService.ensureFix', () => {
  it('waits for a fresh fix when the last one is over a minute old', async () => {
    const service = new LocationService();
    await service.startWatching();
    geo.watch!(position(90_000, 19.0));

    const pending = service.ensureFix(5_000);
    // Let ensureFix subscribe before the fresh fix arrives.
    await new Promise((resolve) => setTimeout(resolve, 0));
    geo.watch!(position(0, 19.2));

    await expect(pending).resolves.toMatchObject({ latitude: 19.2 });
  });

  it('leaves no listener behind that breaks later fixes', async () => {
    const service = new LocationService();
    await service.startWatching();
    geo.watch!(position(90_000));

    const pending = service.ensureFix(5_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    geo.watch!(position(0));
    await pending;

    expect(() => geo.watch!(position(0))).not.toThrow();
  });
});
