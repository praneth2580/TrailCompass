import { describe, expect, it, vi } from 'vitest';
import type { Coordinate } from './routing-adapter';
import { distanceAlongPolylineMeters } from './geo';

vi.mock('../services/road-pack.service', () => ({
  roadPackService: {
    findCoveringPack: async () => null,
    findByCacheKey: async () => null,
    saveFromCollection: async () => null,
  },
}));

const { OfflineRoutingAdapter } = await import('./offline-adapter');

const goregaon: Coordinate = [72.8479, 19.1663];
const ganpatipule: Coordinate = [73.2665, 17.1448];
const towns: Record<string, Coordinate> = {
  Panvel: [73.1175, 18.9894],
  Mahad: [73.4166, 18.0833],
  Chiplun: [73.5156, 17.5323],
  Sangameshwar: [73.5533, 17.1867],
  Lonavala_expressway: [73.4062, 18.7546],
};

describe('live OSM: Goregaon → Ganpatipule', () => {
  it(
    'finds a two-wheeler route',
    async () => {
      vi.stubGlobal('window', globalThis);
      const adapter = new OfflineRoutingAdapter();
      let lastLabel = '';
      adapter.subscribeProgress((p) => {
        if (p.label !== lastLabel) {
          lastLabel = p.label;
          console.log(`[${(performance.now() / 1000).toFixed(1)}s] ${p.label}`);
        }
      });
      const t0 = performance.now();
      const route = await adapter.calculateRoute(goregaon, ganpatipule, {
        profile: 'fastest',
        allowExpressways: false,
      });
      console.log('total s', ((performance.now() - t0) / 1000).toFixed(1));
      console.log('km', (route.distanceMeters / 1000).toFixed(1));
      console.log('h', (route.durationSeconds / 3600).toFixed(2));
      console.log('points', route.coordinates.length, 'id', route.id);
      for (const [name, c] of Object.entries(towns)) {
        const off = distanceAlongPolylineMeters(c, route.coordinates)
          .distanceToRouteMeters;
        console.log(`${name}: ${(off / 1000).toFixed(1)} km off route`);
      }
      expect(route.distanceMeters).toBeGreaterThan(250_000);
    },
    1_500_000,
  );
});
