import type { CalculatedRoute, Coordinate, RoutingAdapter } from './routing-adapter';
import { buildManeuversFromPath } from './maneuver-builder';
import { polylineLengthMeters } from './geo';
import { mergeRoutes } from './route-merge';

export interface ValhallaEngineHandle {
  ready: boolean;
  label: string;
}

/**
 * Optional Valhalla WASM backend.
 * Loaded dynamically so the app builds even when the package is not installed yet.
 * Place tiles at /assets/routing/valhalla-tiles.tar to activate.
 */
export class ValhallaOfflineAdapter implements RoutingAdapter {
  private router: {
    init: () => Promise<void>;
    loadTiles: (buffer: ArrayBuffer) => Promise<void>;
    loadTilesFromUrl?: (url: string) => Promise<void>;
    route: (request: Record<string, unknown>) => Promise<{
      trip?: {
        legs?: Array<{
          shape?: string;
          summary?: { length?: number; time?: number };
          maneuvers?: Array<{
            instruction?: string;
            length?: number;
            type?: number;
          }>;
        }>;
        summary?: { length?: number; time?: number };
      };
    }>;
    dispose?: () => void;
  } | null = null;
  private tilesLoaded = false;
  private initError: string | undefined;

  getStatus(): ValhallaEngineHandle {
    return {
      ready: this.tilesLoaded && this.router != null,
      label: this.tilesLoaded
        ? 'Valhalla WASM'
        : this.initError
          ? `Valhalla unavailable (${this.initError})`
          : 'Valhalla tiles not loaded',
    };
  }

  async tryInitialize(
    tilesUrl = '/assets/routing/valhalla-tiles.tar',
  ): Promise<boolean> {
    try {
      const mod = await import('@jansoft/mbujkanji-valhalla-wasm');
      const createRouter = mod.createRouter;
      if (typeof createRouter !== 'function') {
        this.initError = 'createRouter missing';
        return false;
      }

      const router = createRouter();
      await router.init();

      if (typeof router.loadTilesFromUrl === 'function') {
        await router.loadTilesFromUrl(tilesUrl);
      } else {
        const response = await fetch(tilesUrl);
        if (!response.ok) {
          this.initError = `tiles HTTP ${response.status}`;
          router.dispose?.();
          return false;
        }
        await router.loadTiles(await response.arrayBuffer());
      }

      this.router = router;
      this.tilesLoaded = true;
      this.initError = undefined;
      return true;
    } catch (e) {
      this.initError = e instanceof Error ? e.message : 'init failed';
      this.router = null;
      this.tilesLoaded = false;
      return false;
    }
  }

  async calculateRoute(
    start: Coordinate,
    end: Coordinate,
    waypoints?: Coordinate[],
  ): Promise<CalculatedRoute> {
    if (!this.router || !this.tilesLoaded) {
      throw new Error('Valhalla offline engine is not ready');
    }

    const locations = [
      { lat: start[1], lon: start[0] },
      ...(waypoints ?? []).map((w) => ({ lat: w[1], lon: w[0] })),
      { lat: end[1], lon: end[0] },
    ];

    const result = await this.router.route({
      locations,
      costing: 'motorcycle',
      directions_type: 'maneuvers',
    });

    // One leg per hop between locations; each stop starts a new leg.
    const legs = result.trip?.legs ?? [];
    if (legs.length === 0) {
      throw new Error('Valhalla returned no route leg');
    }

    const route = mergeRoutes(legs.map(legToRoute));
    if (route.coordinates.length < 2) {
      throw new Error('Valhalla route shape was empty');
    }
    return route;
  }

  dispose(): void {
    this.router?.dispose?.();
    this.router = null;
    this.tilesLoaded = false;
  }
}

type ValhallaLeg = {
  shape?: string;
  summary?: { length?: number; time?: number };
  maneuvers?: Array<{ instruction?: string; length?: number; type?: number }>;
};

function legToRoute(leg: ValhallaLeg): CalculatedRoute {
  const coordinates = decodePolyline6(leg.shape ?? '');
  // Valhalla reports lengths in kilometers.
  const distanceMeters =
    (leg.summary?.length ?? 0) * 1000 || polylineLengthMeters(coordinates);
  const durationSeconds = Math.round(leg.summary?.time ?? distanceMeters / 11);
  const instructions =
    leg.maneuvers?.map((m) => ({
      text: m.instruction ?? 'Continue',
      distanceMeters: Math.round((m.length ?? 0) * 1000),
      maneuver: String(m.type ?? 'maneuver'),
    })) ?? buildManeuversFromPath(coordinates);
  return { coordinates, distanceMeters, durationSeconds, instructions };
}

/** Google-encoded polyline with precision 1e-6 (Valhalla default). */
function decodePolyline6(encoded: string): Coordinate[] {
  if (!encoded) return [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates: Coordinate[] = [];

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    coordinates.push([lng / 1e6, lat / 1e6]);
  }

  return coordinates;
}

export const valhallaOfflineAdapter = new ValhallaOfflineAdapter();
