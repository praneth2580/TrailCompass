import { describe, expect, it, vi } from 'vitest';

type FixCallback = (fix: { latitude: number; longitude: number; accuracy: number; time: number; satellites: number }) => void;

const geo = vi.hoisted(() => ({ watch: null as FixCallback | null, source: null as string | null }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock('@capacitor/geolocation', () => ({
  Geolocation: {
    checkPermissions: async () => ({ location: 'granted' }),
    requestPermissions: async () => ({ location: 'granted' }),
  },
}));

// On Android, positions come from RideLocationPlugin in the chosen GPS mode.
vi.mock('./ride-location-plugin', () => ({
  RideLocation: {
    addListener: async (_event: string, callback: FixCallback) => {
      geo.watch = callback;
      return { remove: async () => undefined };
    },
    watch: async ({ source }: { source: string }) => {
      geo.source = source;
    },
    setSource: async ({ source }: { source: string }) => {
      geo.source = source;
    },
    clearWatch: async () => undefined,
  },
}));

vi.stubGlobal('window', globalThis);
const stored = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
});

const { LocationService } = await import('./location.service');

function position(ageMs: number, latitude = 19.1) {
  return { latitude, longitude: 72.85, accuracy: 6, time: Date.now() - ageMs, satellites: 8 };
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

describe('LocationService GPS modes', () => {
  it('starts in the assisted mode, and switches the native source at once', async () => {
    localStorage.removeItem('tc.locationSource');
    const service = new LocationService();
    expect(service.getSource()).toBe('assisted');
    await service.startWatching();
    expect(geo.source).toBe('assisted');

    let changes = 0;
    service.subscribeSource(() => (changes += 1));
    service.setSource('gps');
    expect(geo.source).toBe('gps');
    expect(changes).toBe(1);
    // Remembered for next time.
    expect(new LocationService().getSource()).toBe('gps');
  });

  it('passes on satellites with each fix', async () => {
    const service = new LocationService();
    await service.startWatching();
    geo.watch!(position(0));
    expect(service.getLastFix()).toMatchObject({ satellites: 8, accuracyMeters: 6 });
  });
});

