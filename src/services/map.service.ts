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
  drawRoute(coordinates: Coordinate[], routeIndex?: number): void;
  clearRoute(): void;
  switchToRegion(_regionId: string): Promise<{ ok: boolean; message: string }>;
  reportMapDataStatus(): MapDataStatus;
  dispose(): void;
}

const ROUTE_SOURCE = 'trailcompass-route';
const ROUTE_LAYER = 'trailcompass-route-line';
const GHOST_SOURCE = 'trailcompass-route-ghost';
const GHOST_LAYER = 'trailcompass-route-ghost-line';
const RECALC_SOURCE = 'trailcompass-recalc-link';
const RECALC_LAYER = 'trailcompass-recalc-link-line';
const ALT_SOURCE = 'trailcompass-route-alts';
const ALT_LAYER = 'trailcompass-route-alts-line';
const ALT_HIT_LAYER = 'trailcompass-route-alts-hit';

const ALT_COLORS = ['#5b8def', '#9b7bff', '#3dbea5'];

export class MapLibreAdapter implements MapAdapter {
  private map: MapLibreMap | null = null;
  private positionMarker: Marker | null = null;
  private destinationMarker: Marker | null = null;
  private framedToPosition = false;
  private styleLoaded = false;
  private clickListeners = new Set<(coordinate: Coordinate) => void>();
  private routePickListeners = new Set<(index: number) => void>();
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

    map.on('click', (event) => {
      if (this.map !== map) return;

      // Prefer picking an existing route alternative when the tap hits one.
      const layers = [ALT_HIT_LAYER, ALT_LAYER, ROUTE_LAYER].filter((id) =>
        map.getLayer(id),
      );
      if (layers.length > 0) {
        const hits = map.queryRenderedFeatures(event.point, { layers });
        const picked = hits.find((f) => f.properties?.routeIndex != null);
        if (picked) {
          const index = Number(picked.properties?.routeIndex);
          if (Number.isFinite(index)) {
            for (const listener of this.routePickListeners) listener(index);
            return;
          }
        }
      }

      const coordinate: Coordinate = [event.lngLat.lng, event.lngLat.lat];
      for (const listener of this.clickListeners) listener(coordinate);
    });

    map.on('mouseenter', ALT_LAYER, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', ALT_LAYER, () => {
      map.getCanvas().style.cursor = '';
    });

    this.map = map;
    return map;
  }

  subscribeClick(listener: (coordinate: Coordinate) => void): () => void {
    this.clickListeners.add(listener);
    return () => this.clickListeners.delete(listener);
  }

  subscribeRoutePick(listener: (index: number) => void): () => void {
    this.routePickListeners.add(listener);
    return () => this.routePickListeners.delete(listener);
  }

  setDestination(coordinate: Coordinate | null): void {
    if (!this.map) return;
    if (!coordinate) {
      this.destinationMarker?.remove();
      this.destinationMarker = null;
      return;
    }
    const lngLat: [number, number] = [coordinate[0], coordinate[1]];
    if (!this.destinationMarker) {
      this.destinationMarker = new Marker({
        element: createDestinationPinElement(),
        anchor: 'bottom',
        offset: [0, 2],
      })
        .setLngLat(lngLat)
        .addTo(this.map);
    } else {
      this.destinationMarker.setLngLat(lngLat);
    }
  }

  fitBounds(
    west: number,
    south: number,
    east: number,
    north: number,
    padding = 48,
  ): void {
    if (!this.map) return;
    this.framedToPosition = true;
    this.map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding, duration: 700 },
    );
  }

  getCenter(): Coordinate | null {
    if (!this.map) return null;
    const c = this.map.getCenter();
    return [c.lng, c.lat];
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

  /** Jump to a coordinate (e.g. “my location”) and zoom to street level. */
  centerOn(coordinate: Coordinate, zoom = INITIAL_FOLLOW_ZOOM): void {
    if (!this.map) return;
    const lngLat: [number, number] = [coordinate[0], coordinate[1]];
    this.framedToPosition = true;

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

    this.map.easeTo({
      center: lngLat,
      zoom,
      duration: 550,
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

  drawRoute(coordinates: Coordinate[], routeIndex = 0): void {
    if (!this.map) return;
    this.ensureRouteLayer(this.map);
    const source = this.map.getSource(ROUTE_SOURCE);
    if (!(source instanceof GeoJSONSource)) return;
    source.setData({
      type: 'Feature',
      properties: { routeIndex },
      geometry: {
        type: 'LineString',
        coordinates,
      },
    });
    this.setRouteRecalculating(false);
  }

  /** Keep the previous path visible (dashed) while a new one is calculated. */
  drawGhostRoute(coordinates: Coordinate[]): void {
    if (!this.map || coordinates.length < 2) return;
    this.ensureRouteLayer(this.map);
    const source = this.map.getSource(GHOST_SOURCE);
    if (!(source instanceof GeoJSONSource)) return;
    source.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    });
  }

  clearGhostRoute(): void {
    if (!this.map) return;
    const source = this.map.getSource(GHOST_SOURCE);
    if (!(source instanceof GeoJSONSource)) return;
    source.setData({ type: 'FeatureCollection', features: [] });
  }

  /**
   * Thin dashed link from the rider to the destination while recalculating,
   * so the map shows work-in-progress even before the new path arrives.
   */
  drawRecalcLink(from: Coordinate, to: Coordinate): void {
    if (!this.map) return;
    this.ensureRouteLayer(this.map);
    const source = this.map.getSource(RECALC_SOURCE);
    if (!(source instanceof GeoJSONSource)) return;
    source.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [from, to] },
    });
  }

  clearRecalcLink(): void {
    if (!this.map) return;
    const source = this.map.getSource(RECALC_SOURCE);
    if (!(source instanceof GeoJSONSource)) return;
    source.setData({ type: 'FeatureCollection', features: [] });
  }

  setRouteRecalculating(active: boolean): void {
    if (!this.map || !this.map.getLayer(ROUTE_LAYER)) return;
    if (active) {
      this.map.setPaintProperty(ROUTE_LAYER, 'line-opacity', 0.35);
      this.map.setPaintProperty(ROUTE_LAYER, 'line-dasharray', [1.2, 1.6]);
      this.map.setPaintProperty(ROUTE_LAYER, 'line-color', '#c47d10');
    } else {
      this.map.setPaintProperty(ROUTE_LAYER, 'line-opacity', 0.92);
      this.map.setPaintProperty(ROUTE_LAYER, 'line-dasharray', undefined);
      this.map.setPaintProperty(ROUTE_LAYER, 'line-color', '#F5A623');
    }
  }

  /**
   * Draw alternative corridors under the active orange route.
   * `showAll` keeps every option vivid; otherwise non-selected stay faint.
   */
  drawAlternatives(
    routes: Coordinate[][],
    selectedIndex: number,
    showAll = false,
  ): void {
    if (!this.map) return;
    this.ensureRouteLayer(this.map);
    const source = this.map.getSource(ALT_SOURCE);
    if (!(source instanceof GeoJSONSource)) return;

    const features = routes
      .map((coordinates, index) => {
        if (coordinates.length < 2) return null;
        // Keep a wide hit target for every option, including the selected one.
        return {
          type: 'Feature' as const,
          properties: {
            routeIndex: index,
            color: ALT_COLORS[index % ALT_COLORS.length],
            emphasis: showAll || index !== selectedIndex ? 1 : 0,
            selected: index === selectedIndex ? 1 : 0,
            hidden: !showAll && index === selectedIndex ? 1 : 0,
          },
          geometry: { type: 'LineString' as const, coordinates },
        };
      })
      .filter((f): f is NonNullable<typeof f> => f != null);

    source.setData({ type: 'FeatureCollection', features });

    if (this.map.getLayer(ALT_LAYER)) {
      this.map.setPaintProperty(ALT_LAYER, 'line-opacity', [
        'case',
        ['==', ['get', 'hidden'], 1],
        0,
        showAll
          ? ['case', ['==', ['get', 'selected'], 1], 0.35, 0.75]
          : 0.55,
      ]);
      this.map.setPaintProperty(
        ALT_LAYER,
        'line-width',
        showAll
          ? ['case', ['==', ['get', 'selected'], 1], 3.5, 4.5]
          : 4,
      );
    }

    if (showAll && routes.length > 0) {
      const all = routes.flat();
      if (all.length > 0) this.fitRoute(all);
    }
  }

  /** Stable color for a route option index (matches UI swatches). */
  alternativeColor(index: number): string {
    return ALT_COLORS[index % ALT_COLORS.length]!;
  }

  clearAlternatives(): void {
    if (!this.map) return;
    const source = this.map.getSource(ALT_SOURCE);
    if (!(source instanceof GeoJSONSource)) return;
    source.setData({ type: 'FeatureCollection', features: [] });
  }

  clearRoute(): void {
    if (!this.map) return;
    const source = this.map.getSource(ROUTE_SOURCE);
    if (source instanceof GeoJSONSource) {
      source.setData({ type: 'FeatureCollection', features: [] });
    }
    this.clearGhostRoute();
    this.clearRecalcLink();
    this.clearAlternatives();
    this.setRouteRecalculating(false);
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
    this.destinationMarker?.remove();
    this.destinationMarker = null;
    this.clickListeners.clear();
    this.routePickListeners.clear();
    this.framedToPosition = false;
    this.styleLoaded = false;
    this.map?.remove();
    this.map = null;
  }

  private ensureRouteLayer(map: MapLibreMap): void {
    if (!map.getSource(GHOST_SOURCE)) {
      map.addSource(GHOST_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: GHOST_LAYER,
        type: 'line',
        source: GHOST_SOURCE,
        paint: {
          'line-color': '#8fa698',
          'line-width': 4,
          'line-opacity': 0.55,
          'line-dasharray': [2, 2],
        },
      });
    }

    if (!map.getSource(RECALC_SOURCE)) {
      map.addSource(RECALC_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: RECALC_LAYER,
        type: 'line',
        source: RECALC_SOURCE,
        paint: {
          'line-color': '#ff6b4a',
          'line-width': 3,
          'line-opacity': 0.75,
          'line-dasharray': [1, 1.4],
        },
      });
    }

    if (!map.getSource(ALT_SOURCE)) {
      map.addSource(ALT_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: ALT_HIT_LAYER,
        type: 'line',
        source: ALT_SOURCE,
        paint: {
          'line-color': '#000000',
          'line-width': 28,
          'line-opacity': 0,
        },
      });
      map.addLayer({
        id: ALT_LAYER,
        type: 'line',
        source: ALT_SOURCE,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 4,
          'line-opacity': 0.55,
          'line-dasharray': [1.5, 1.2],
        },
      });
    }

    if (!map.getSource(ROUTE_SOURCE)) {
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
          'line-opacity': 0.92,
        },
      });
    }
  }

  private setStatus(status: MapDataStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

function createDestinationPinElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'tc-destination-marker';
  el.setAttribute('aria-label', 'Destination');
  el.innerHTML = `
    <svg class="tc-destination-pin" viewBox="0 0 40 52" width="36" height="47" aria-hidden="true">
      <path
        fill="#f0a020"
        stroke="#1a1205"
        stroke-width="2"
        d="M20 2C11.2 2 4 9.2 4 18c0 12.5 16 30 16 30s16-17.5 16-30C36 9.2 28.8 2 20 2z"
      />
      <circle cx="20" cy="18" r="6.5" fill="#1a1205" />
      <circle cx="20" cy="18" r="3.2" fill="#f5f0e6" />
    </svg>
  `;
  return el;
}

export const mapService = new MapLibreAdapter();
