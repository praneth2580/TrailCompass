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
/** Locked camera zoom while actively navigating and following the rider. */
export const NAVIGATION_FOLLOW_ZOOM = 16.5;

export interface MapDataStatus {
  ok: boolean;
  message: string;
}

export interface MapAdapter {
  initialize(container: HTMLElement): MapLibreMap;
  showPosition(
    coordinate: Coordinate,
    headingDegrees?: number | null,
    options?: { follow?: boolean; lockZoom?: number },
  ): void;
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

/** Navigation chevron; tip points toward heading (0° = north). */
const POSITION_ARROW_HTML = `
<span class="tc-position-arrow-spin">
  <svg class="tc-position-arrow" viewBox="0 0 48 48" width="36" height="36" aria-hidden="true">
    <path d="M24 4 L40 40 L24 32 L8 40 Z" fill="#3b8ef0" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>
  </svg>
</span>
`;

export class MapLibreAdapter implements MapAdapter {
  private map: MapLibreMap | null = null;
  private positionMarker: Marker | null = null;
  private positionEl: HTMLDivElement | null = null;
  private positionMode: 'dot' | 'arrow' = 'dot';
  private destinationMarker: Marker | null = null;
  private stopMarkers: Marker[] = [];
  private framedToPosition = false;
  private styleLoaded = false;
  private clickListeners = new Set<(coordinate: Coordinate) => void>();
  private routePickListeners = new Set<(index: number) => void>();
  private cameraBreakListeners = new Set<() => void>();
  private statusListeners = new Set<(status: MapDataStatus) => void>();
  private followCamera = true;
  /** False while another tab covers the (still mounted) map. */
  private visible = true;
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
      this.styleLoaded = true;
      this.ensureRouteLayer(map);
      // Listeners redraw anything that was skipped while the style loaded.
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

    // Break GPS camera follow when the user pans/zooms/rotates the map.
    const onUserCameraGesture = (event: { originalEvent?: Event }) => {
      if (!event.originalEvent) return;
      this.breakCameraFollow();
    };
    map.on('dragstart', onUserCameraGesture);
    map.on('zoomstart', onUserCameraGesture);
    map.on('rotatestart', onUserCameraGesture);
    map.on('pitchstart', onUserCameraGesture);

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

  /** Fired when the user moves the camera (so UI can turn off follow mode). */
  subscribeCameraBreak(listener: () => void): () => void {
    this.cameraBreakListeners.add(listener);
    return () => this.cameraBreakListeners.delete(listener);
  }

  setFollowCamera(follow: boolean): void {
    this.followCamera = follow;
  }

  /**
   * The map stays mounted behind other tabs so it does not reload. While
   * hidden, GPS fixes move the marker but do not animate the camera.
   */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) this.map?.resize();
  }

  private breakCameraFollow(): void {
    if (!this.followCamera) return;
    this.followCamera = false;
    for (const listener of this.cameraBreakListeners) listener();
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

  /**
   * Draw intermediate itinerary stops (fuel / food / manual).
   * Destination stays on setDestination.
   */
  setItineraryStops(
    stops: Array<{
      coordinate: Coordinate;
      kind: 'fuel' | 'food' | 'manual' | 'destination';
      name?: string;
    }>,
  ): void {
    if (!this.map) return;
    this.clearItineraryStops();
    for (const stop of stops) {
      if (stop.kind === 'destination') continue;
      const marker = new Marker({
        element: createStopPinElement(stop.kind, stop.name),
        anchor: 'bottom',
        offset: [0, 2],
      })
        .setLngLat([stop.coordinate[0], stop.coordinate[1]])
        .addTo(this.map);
      this.stopMarkers.push(marker);
    }
  }

  clearItineraryStops(): void {
    for (const marker of this.stopMarkers) marker.remove();
    this.stopMarkers = [];
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

  /** Dot for idle map, arrow for active navigation. */
  setPositionMode(mode: 'dot' | 'arrow'): void {
    if (this.positionMode === mode) return;
    this.positionMode = mode;
    this.applyPositionMarkerChrome(null);
  }

  /**
   * Update the rider marker. Camera only recenters while follow is enabled
   * (or on the very first GPS fix so the map isn't stuck at world view).
   */
  showPosition(
    coordinate: Coordinate,
    headingDegrees?: number | null,
    options?: { follow?: boolean; lockZoom?: number },
  ): void {
    if (!this.map) return;
    const lngLat: [number, number] = [coordinate[0], coordinate[1]];
    this.ensurePositionMarker(lngLat);
    this.applyPositionMarkerChrome(headingDegrees);
    if (!this.visible) return;

    const follow = options?.follow ?? this.followCamera;
    const firstFix = !this.framedToPosition;
    if (!follow && !firstFix) return;

    this.framedToPosition = true;
    const zoom =
      options?.lockZoom ?? (firstFix ? INITIAL_FOLLOW_ZOOM : undefined);
    this.map.easeTo({
      center: lngLat,
      duration: firstFix ? 400 : 220,
      ...(zoom != null ? { zoom } : {}),
    });
  }

  /** Jump to a coordinate (e.g. “my location”) and zoom to street level. */
  centerOn(coordinate: Coordinate, zoom = INITIAL_FOLLOW_ZOOM): void {
    if (!this.map) return;
    const lngLat: [number, number] = [coordinate[0], coordinate[1]];
    this.followCamera = true;
    this.framedToPosition = true;
    this.ensurePositionMarker(lngLat);
    this.applyPositionMarkerChrome(null);

    this.map.easeTo({
      center: lngLat,
      zoom,
      duration: 550,
    });
  }

  /** Resume navigation follow at the locked street zoom. */
  resumeNavigationFollow(
    coordinate: Coordinate,
    headingDegrees?: number | null,
  ): void {
    this.followCamera = true;
    this.showPosition(coordinate, headingDegrees, {
      follow: true,
      lockZoom: NAVIGATION_FOLLOW_ZOOM,
    });
  }

  private ensurePositionMarker(lngLat: [number, number]): void {
    if (!this.map) return;
    if (!this.positionMarker || !this.positionEl) {
      const el = document.createElement('div');
      el.className = 'tc-position-marker';
      el.setAttribute('aria-label', 'Current GPS position');
      this.positionEl = el;
      this.positionMarker = new Marker({ element: el })
        .setLngLat(lngLat)
        .addTo(this.map);
      this.applyPositionMarkerChrome(null);
    } else {
      this.positionMarker.setLngLat(lngLat);
    }
  }

  private applyPositionMarkerChrome(
    headingDegrees: number | null | undefined,
  ): void {
    const el = this.positionEl;
    if (!el) return;

    if (this.positionMode === 'arrow') {
      el.className = 'tc-position-marker tc-position-marker-arrow';
      if (!el.querySelector('.tc-position-arrow-spin')) {
        el.innerHTML = POSITION_ARROW_HTML;
      }
      const spin = el.querySelector('.tc-position-arrow-spin') as HTMLElement | null;
      const heading =
        headingDegrees != null && Number.isFinite(headingDegrees)
          ? headingDegrees
          : 0;
      if (spin) spin.style.transform = `rotate(${heading}deg)`;
    } else {
      el.className = 'tc-position-marker';
      el.innerHTML = '';
    }
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
    if (!this.ensureRouteLayer(this.map)) return;
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
    if (!this.ensureRouteLayer(this.map)) return;
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
    if (!this.ensureRouteLayer(this.map)) return;
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
    if (!this.ensureRouteLayer(this.map)) return;
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

  clearItinerary(): void {
    this.setDestination(null);
    this.clearItineraryStops();
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
    this.positionEl = null;
    this.positionMode = 'dot';
    this.destinationMarker?.remove();
    this.destinationMarker = null;
    this.clearItineraryStops();
    this.clickListeners.clear();
    this.routePickListeners.clear();
    this.framedToPosition = false;
    this.styleLoaded = false;
    this.map?.remove();
    this.map = null;
  }

  /**
   * Add the route sources and layers. Returns false until the style has
   * loaded: MapLibre throws "Style is not done loading" on addSource before
   * then. Whatever was skipped is redrawn when the status turns ok.
   */
  private ensureRouteLayer(map: MapLibreMap): boolean {
    if (!this.styleLoaded) return false;

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
    return true;
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

function createStopPinElement(
  kind: 'fuel' | 'food' | 'manual',
  name?: string,
): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `tc-stop-marker tc-stop-marker-${kind}`;
  el.setAttribute('aria-label', name ?? kind);
  const fill =
    kind === 'fuel' ? '#3dbea5' : kind === 'food' ? '#e07a5f' : '#7b8cff';
  const glyph = kind === 'fuel' ? 'F' : kind === 'food' ? 'E' : '+';
  el.innerHTML = `
    <svg class="tc-stop-pin" viewBox="0 0 40 52" width="30" height="39" aria-hidden="true">
      <path
        fill="${fill}"
        stroke="#1a1205"
        stroke-width="2"
        d="M20 2C11.2 2 4 9.2 4 18c0 12.5 16 30 16 30s16-17.5 16-30C36 9.2 28.8 2 20 2z"
      />
      <circle cx="20" cy="18" r="8" fill="#1a1205" />
      <text x="20" y="22.5" text-anchor="middle" font-size="12" font-family="sans-serif" font-weight="700" fill="#f5f0e6">${glyph}</text>
    </svg>
  `;
  return el;
}

export const mapService = new MapLibreAdapter();
