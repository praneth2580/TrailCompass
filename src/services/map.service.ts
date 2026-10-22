import {
  GeoJSONSource,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Coordinate } from '../routing/routing-adapter';
import { registerTileProtocol } from '../offline/tile-protocol';

// Vite does not place MapLibre's worker next to the optimized dependency.
// Point at the packaged worker before any map is created.
setWorkerUrl(maplibreWorkerUrl);

/**
 * Live online basemap. OpenFreeMap publishes this MapLibre style for app use
 * with no API key. Tiles are OpenStreetMap data via OpenMapTiles.
 * A network connection is required. This is not an offline package — the
 * local PMTiles bridge is still pending (see offline/tile-protocol.ts).
 */
export const ONLINE_MAP_STYLE_URL =
  'https://tiles.openfreemap.org/styles/liberty';

export const ONLINE_MAP_STYLE_NOTE =
  'Online map (OpenFreeMap) — needs a network connection';

/** Zoom applied on the first GPS fix so the world view becomes a street view. */
const INITIAL_FOLLOW_ZOOM = 15;

export interface MapDataStatus {
  ok: boolean;
  message: string;
}

export interface MapAdapter {
  initialize(container: HTMLElement): MapLibreMap;
  showPosition(coordinate: Coordinate, headingDegrees?: number | null): void;
  fitRoute(coordinates: Coordinate[]): void;
  drawRoute(coordinates: Coordinate[]): void;
  clearRoute(): void;
  switchToRegion(_regionId: string): Promise<{ ok: boolean; message: string }>;
  reportMapDataStatus(): MapDataStatus;
  dispose(): void;
}

const ROUTE_SOURCE = 'trailcompass-route';
const ROUTE_LAYER = 'trailcompass-route-line';

export class MapLibreAdapter implements MapAdapter {
  private map: MapLibreMap | null = null;
  private positionMarker: Marker | null = null;
  private framedToPosition = false;
  private styleLoaded = false;
  private statusListeners = new Set<(status: MapDataStatus) => void>();
  private status: MapDataStatus = {
    ok: false,
    message: 'Loading online map…',
  };

  subscribeStatus(listener: (status: MapDataStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  initialize(container: HTMLElement): MapLibreMap {
    if (this.map) {
      this.dispose();
    }

    this.framedToPosition = false;
    this.styleLoaded = false;
    this.setStatus({ ok: false, message: 'Loading online map…' });

    registerTileProtocol();

    const map = new MapLibreMap({
      container,
      style: ONLINE_MAP_STYLE_URL,
      center: [0, 20],
      zoom: 1.5,
      attributionControl: { compact: true },
    });

    map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right');

    map.on('load', () => {
      if (this.map !== map) return;
      this.ensureRouteLayer(map);
      this.styleLoaded = true;
      this.setStatus({ ok: true, message: ONLINE_MAP_STYLE_NOTE });
    });

    map.on('error', (event) => {
      if (this.map !== map || this.styleLoaded) return;
      const detail =
        event.error instanceof Error ? event.error.message : 'network error';
      this.setStatus({
        ok: false,
        message: `Online map failed to load (${detail}). Check the network connection.`,
      });
    });

    this.map = map;
    return map;
  }

  showPosition(coordinate: Coordinate, _headingDegrees?: number | null): void {
    if (!this.map) return;
    const lngLat: [number, number] = [coordinate[0], coordinate[1]];

    if (!this.positionMarker) {
      const el = document.createElement('div');
      el.className = 'tc-position-marker';
      el.setAttribute('aria-label', 'Current GPS position');
      this.positionMarker = new Marker({ element: el })
        .setLngLat(lngLat)
        .addTo(this.map);
    } else {
      this.positionMarker.setLngLat(lngLat);
    }

    // Keep following the fix. The first fix also zooms in from the world view.
    // Later fixes only recenter, so a manual zoom stays put.
    const frameZoom = !this.framedToPosition;
    this.framedToPosition = true;
    this.map.easeTo({
      center: lngLat,
      duration: 400,
      ...(frameZoom ? { zoom: INITIAL_FOLLOW_ZOOM } : {}),
    });
  }

  fitRoute(coordinates: Coordinate[]): void {
    if (!this.map || coordinates.length === 0) return;
    const first = coordinates[0] as [number, number];
    const bounds = coordinates.reduce(
      (b, c) => b.extend(c as [number, number]),
      new LngLatBounds(first, first),
    );
    this.map.fitBounds(bounds, { padding: 48, duration: 600 });
  }

  drawRoute(coordinates: Coordinate[]): void {
    if (!this.map) return;
    const source = this.map.getSource(ROUTE_SOURCE);
    if (!(source instanceof GeoJSONSource)) return;
    source.setData({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates,
      },
    });
  }

  clearRoute(): void {
    if (!this.map) return;
    const source = this.map.getSource(ROUTE_SOURCE);
    if (!(source instanceof GeoJSONSource)) return;
    source.setData({ type: 'FeatureCollection', features: [] });
  }

  async switchToRegion(_regionId: string): Promise<{ ok: boolean; message: string }> {
    return {
      ok: false,
      message:
        'Region switch unavailable — offline map packages and local tile bridge not implemented yet',
    };
  }

  reportMapDataStatus(): MapDataStatus {
    return this.status;
  }

  dispose(): void {
    this.positionMarker?.remove();
    this.positionMarker = null;
    this.framedToPosition = false;
    this.styleLoaded = false;
    this.map?.remove();
    this.map = null;
  }

  private ensureRouteLayer(map: MapLibreMap): void {
    if (map.getSource(ROUTE_SOURCE)) return;
    map.addSource(ROUTE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: ROUTE_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      paint: {
        'line-color': '#F5A623',
        'line-width': 5,
        'line-opacity': 0.9,
      },
    });
  }

  private setStatus(status: MapDataStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

export const mapService = new MapLibreAdapter();
