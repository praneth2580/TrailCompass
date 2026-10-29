import {
  GeoJSONSource,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type PaddingOptions,
} from 'maplibre-gl';
import type { Feature } from 'geojson';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Coordinate } from '../routing/routing-adapter';
import {
  buildMapStyle,
  FOOD_CLASSES,
  FUEL_CLASSES,
  registerTileProtocol,
} from '../offline/tile-protocol';
import { mapPackService } from './map-pack.service';
import { bundledPoisInBounds } from './bundled-pois.service';

// Vite does not place MapLibre's worker next to the optimized dependency.
// Point at the packaged worker before any map is created.
setWorkerUrl(maplibreWorkerUrl);

/**
 * Basemap: OpenFreeMap's Liberty style (OpenStreetMap data via
 * OpenMapTiles), no API key. Tiles come from a saved route's offline map
 * when it has them, else from the network (see offline/tile-protocol.ts).
 */
export const MAP_STYLE_NOTE =
  'Map by OpenFreeMap — saved trips keep their map offline';

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
  fitRoute(coordinates: Coordinate[], padding?: number | PaddingOptions): void;
  drawRoute(coordinates: Coordinate[], routeIndex?: number): void;
  clearRoute(): void;
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

/** A ride being recorded, and a past ride opened from the ride log. */
export type RideLineKind = 'live' | 'view';
const RIDE_LINES: Record<RideLineKind, { source: string; layer: string; color: string }> = {
  live: { source: 'trailcompass-ride-live', layer: 'trailcompass-ride-live-line', color: '#ff5a5f' },
  view: { source: 'trailcompass-ride-view', layer: 'trailcompass-ride-view-line', color: '#b28dff' },
};

const POI_SOURCE = 'trailcompass-pois';
/** Bundled Overture places (India), then OpenStreetMap's from the tiles elsewhere. */
const POI_LAYERS = {
  fuel: 'trailcompass-poi-fuel',
  food: 'trailcompass-poi-food',
  osmFuel: 'trailcompass-poi-osm-fuel',
  osmFood: 'trailcompass-poi-osm-food',
} as const;
/** Fuel shows from further out than food; places to eat are far denser. */
const POI_MIN_ZOOM = { fuel: 10, food: 13 };
const POI_LABEL_ZOOM = 15;
const POI_COLORS = { fuel: '#3dbea5', food: '#e07a5f' };
const OVERLAY_PREF_KEY = 'tc.mapOverlays';
/** Before overlays could be picked one by one: '0' hid the fuel & food layer. */
const OLD_POI_PREF_KEY = 'tc.mapPois';

/** Places the map can draw over the basemap; each is switched on in settings. */
export type MapOverlay = 'fuel' | 'food';

export const MAP_OVERLAYS: Array<{ id: MapOverlay; label: string }> = [
  { id: 'fuel', label: 'Fuel stations' },
  { id: 'food', label: 'Restaurants' },
];

/** `shown` is the map's show/hide-all button; the rest are the settings. */
export type MapOverlaySettings = { shown: boolean } & Record<MapOverlay, boolean>;

/** Go here; add as a stop on the trip; or answer the Plan tab's "tap to place" request. */
export type PoiAction = 'destination' | 'stop' | 'pick';

const POI_ACTION_LABELS: Record<PoiAction, string> = {
  destination: 'Go here',
  stop: 'Add stop',
  pick: 'Use this place',
};

export interface MapPoi {
  name: string;
  kind: 'fuel' | 'food';
  coordinate: Coordinate;
  source: string;
}

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
  /** Unwrapped arrow rotation, so crossing north turns the short way. */
  private arrowAngle: number | null = null;
  private destinationMarker: Marker | null = null;
  private stopMarkers: Marker[] = [];
  private framedToPosition = false;
  private styleLoaded = false;
  private clickListeners = new Set<(coordinate: Coordinate) => void>();
  private routePickListeners = new Set<(index: number) => void>();
  private cameraBreakListeners = new Set<() => void>();
  private statusListeners = new Set<(status: MapDataStatus) => void>();
  private poiActionListeners = new Set<(poi: MapPoi, action: PoiAction) => void>();
  private poiActions: PoiAction[] = [];
  private overlays = readOverlayPreference();
  private overlayListeners = new Set<() => void>();
  private poiPopup: Popup | null = null;
  private poiPopupKind: MapOverlay | null = null;
  private poiToken = 0;
  private rideLines: Record<RideLineKind, Coordinate[][] | null> = { live: null, view: null };
  private followCamera = true;
  /** False while another tab covers the (still mounted) map. */
  private visible = true;
  private status: MapDataStatus = {
    ok: false,
    message: 'Loading map…',
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
    this.setStatus({ ok: false, message: 'Loading map…' });

    registerTileProtocol();
    // Saved offline maps join the tile lookup as soon as they're listed.
    void mapPackService.init();

    const map = new MapLibreMap({
      container,
      style: buildMapStyle(),
      center: [0, 20],
      zoom: 1.5,
      attributionControl: { compact: true },
    });

    map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right');

    map.on('load', () => {
      if (this.map !== map) return;
      this.styleLoaded = true;
      this.ensureRouteLayer(map);
      this.ensurePoiLayers(map);
      void this.refreshPois();
      this.drawRideLines(map);
      // Listeners redraw anything that was skipped while the style loaded.
      this.setStatus({ ok: true, message: MAP_STYLE_NOTE });
    });

    map.on('moveend', () => {
      if (this.map === map) void this.refreshPois();
    });

    map.on('error', (event) => {
      if (this.map !== map || this.styleLoaded) return;
      const detail =
        event.error instanceof Error ? event.error.message : 'network error';
      this.setStatus({
        ok: false,
        message: `Map failed to load (${detail}). Check the network connection.`,
      });
    });

    map.on('click', (event) => {
      if (this.map !== map) return;

      // A fuel station or place to eat: show what it is.
      const poi = this.poiAt(map, event.point);
      if (poi) {
        this.showPoiPopup(map, poi);
        return;
      }

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
        this.arrowAngle = null;
      }
      const spin = el.querySelector('.tc-position-arrow-spin') as HTMLElement | null;
      const heading =
        headingDegrees != null && Number.isFinite(headingDegrees)
          ? headingDegrees
          : 0;
      const prev = this.arrowAngle;
      this.arrowAngle =
        prev == null ? heading : prev + ((((heading - prev) % 360) + 540) % 360) - 180;
      if (spin) spin.style.transform = `rotate(${this.arrowAngle}deg)`;
    } else {
      el.className = 'tc-position-marker';
      el.innerHTML = '';
    }
  }

  /** `padding` keeps the route clear of overlays (e.g. zen mode's compass). */
  fitRoute(coordinates: Coordinate[], padding: number | PaddingOptions = 48): void {
    if (!this.map || coordinates.length === 0) return;
    const first = coordinates[0] as [number, number];
    const bounds = coordinates.reduce(
      (b, c) => b.extend(c as [number, number]),
      new LngLatBounds(first, first),
    );
    this.map.fitBounds(bounds, { padding, duration: 600 });
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

  /** A recorded track, split where the ride was paused; null removes it. */
  setRideLine(kind: RideLineKind, lines: Coordinate[][] | null): void {
    this.rideLines[kind] = lines && lines.some((line) => line.length > 1) ? lines : null;
    if (this.map && this.styleLoaded) this.drawRideLines(this.map);
  }

  private drawRideLines(map: MapLibreMap): void {
    for (const kind of ['view', 'live'] as const) {
      const { source, layer, color } = RIDE_LINES[kind];
      if (!map.getSource(source)) {
        map.addSource(source, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer(
          {
            id: layer,
            type: 'line',
            source,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': color, 'line-width': 4, 'line-opacity': 0.9 },
          },
          // Under the planned route.
          map.getLayer(GHOST_LAYER) ? GHOST_LAYER : undefined,
        );
      }
      const data = map.getSource(source);
      if (data instanceof GeoJSONSource) {
        const lines = this.rideLines[kind] ?? [];
        data.setData({
          type: 'FeatureCollection',
          features: lines
            .filter((line) => line.length > 1)
            .map((line) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } })),
        });
      }
    }
  }

  /** Taps on a popup's "Go here" / "Add stop". */
  subscribePoiAction(listener: (poi: MapPoi, action: PoiAction) => void): () => void {
    this.poiActionListeners.add(listener);
    return () => this.poiActionListeners.delete(listener);
  }

  /** Which buttons a fuel or food popup offers (none mid-ride). */
  setPoiActions(actions: PoiAction[]): void {
    this.poiActions = actions;
  }

  getOverlays(): MapOverlaySettings {
    return this.overlays;
  }

  /** Whether any overlay is on the map right now. */
  overlaysOnMap(): boolean {
    return this.overlays.shown && MAP_OVERLAYS.some(({ id }) => this.overlays[id]);
  }

  /**
   * The map's show/hide-all button. Showing with every overlay switched
   * off in settings switches them all on, so the button always does something.
   */
  setOverlaysShown(shown: boolean): void {
    const none = !MAP_OVERLAYS.some(({ id }) => this.overlays[id]);
    const all = Object.fromEntries(MAP_OVERLAYS.map(({ id }) => [id, true]));
    this.updateOverlays({ shown, ...(shown && none ? all : {}) });
  }

  /** One overlay's setting; switching one on also shows the overlays. */
  setOverlay(overlay: MapOverlay, on: boolean): void {
    this.updateOverlays({ [overlay]: on, ...(on ? { shown: true } : {}) });
  }

  subscribeOverlays(listener: () => void): () => void {
    this.overlayListeners.add(listener);
    return () => this.overlayListeners.delete(listener);
  }

  private updateOverlays(change: Partial<MapOverlaySettings>): void {
    this.overlays = { ...this.overlays, ...change };
    try {
      localStorage.setItem(OVERLAY_PREF_KEY, JSON.stringify(this.overlays));
    } catch {
      // Kept for this session.
    }
    if (this.poiPopupKind && !this.overlayOn(this.poiPopupKind)) this.poiPopup?.remove();
    void this.refreshPois();
    for (const listener of [...this.overlayListeners]) listener();
  }

  private overlayOn(overlay: MapOverlay): boolean {
    return this.overlays.shown && this.overlays[overlay];
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
    this.poiPopup?.remove();
    this.poiPopup = null;
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

  private ensurePoiLayers(map: MapLibreMap): void {
    if (map.getSource(POI_SOURCE)) return;
    for (const kind of ['fuel', 'food'] as const) {
      if (!map.hasImage(poiIconName(kind))) {
        map.addImage(poiIconName(kind), drawPoiIcon(kind), { pixelRatio: 2 });
      }
    }
    map.addSource(POI_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    const layout = (name: unknown, kind: 'fuel' | 'food') => ({
      'icon-image': poiIconName(kind),
      'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.75, 15, 1],
      'icon-padding': 4,
      'icon-allow-overlap': false,
      'symbol-sort-key': ['case', ['==', name, ''], 1, 0],
      'text-field': ['step', ['zoom'], '', POI_LABEL_ZOOM, name],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-max-width': 8,
      'text-optional': true,
    });
    const paint = {
      'text-color': '#3b3b3b',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.2,
    };
    const osmName = ['coalesce', ['get', 'name:latin'], ['get', 'name'], ''];
    const layers = [
      { id: POI_LAYERS.osmFood, kind: 'food', source: 'openmaptiles', classes: FOOD_CLASSES },
      { id: POI_LAYERS.osmFuel, kind: 'fuel', source: 'openmaptiles', classes: FUEL_CLASSES },
      { id: POI_LAYERS.food, kind: 'food', source: POI_SOURCE },
      { id: POI_LAYERS.fuel, kind: 'fuel', source: POI_SOURCE },
    ] as const;
    for (const layer of layers) {
      const osm = 'classes' in layer;
      if (osm && !map.getSource('openmaptiles')) continue;
      map.addLayer({
        id: layer.id,
        type: 'symbol',
        source: layer.source,
        ...(osm ? { 'source-layer': 'poi' } : {}),
        minzoom: POI_MIN_ZOOM[layer.kind],
        filter: osm
          ? ['match', ['get', 'class'], [...layer.classes], true, false]
          : ['==', ['get', 'kind'], layer.kind],
        layout: {
          ...layout(osm ? osmName : ['get', 'name'], layer.kind),
          visibility: 'none',
        },
        paint,
      } as unknown as Parameters<MapLibreMap['addLayer']>[0]);
    }
  }

  /** Loads the bundled places for the view and picks which layers show. */
  private async refreshPois(): Promise<void> {
    const map = this.map;
    if (!map || !this.styleLoaded || !map.getSource(POI_SOURCE)) return;
    const token = ++this.poiToken;
    const zoom = map.getZoom();
    const kinds = MAP_OVERLAYS.map(({ id }) => id).filter(
      (kind) => this.overlayOn(kind) && zoom >= POI_MIN_ZOOM[kind],
    );
    let covered = false;
    let features: Feature[] = [];
    if (kinds.length > 0) {
      const b = map.getBounds();
      const bbox: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      const results = await Promise.all(kinds.map((kind) => bundledPoisInBounds(kind, bbox)));
      if (token !== this.poiToken || this.map !== map) return;
      covered = results.some((result) => result.covered);
      features = results.flatMap((result) =>
        result.places.map((place) => ({
          type: 'Feature' as const,
          properties: { name: place.name, kind: place.kind, source: 'Overture Maps' },
          geometry: { type: 'Point' as const, coordinates: place.coordinate },
        })),
      );
    }
    const source = map.getSource(POI_SOURCE);
    if (source instanceof GeoJSONSource) {
      source.setData({ type: 'FeatureCollection', features });
    }
    const visibility = (on: boolean) => (on ? 'visible' : 'none');
    const layers = [
      { id: POI_LAYERS.fuel, on: this.overlayOn('fuel') },
      { id: POI_LAYERS.food, on: this.overlayOn('food') },
      // Where the bundled data covers the view, OSM's (fewer) places would only double up.
      { id: POI_LAYERS.osmFuel, on: this.overlayOn('fuel') && !covered },
      { id: POI_LAYERS.osmFood, on: this.overlayOn('food') && !covered },
    ];
    for (const { id, on } of layers) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility(on));
    }
  }

  private poiAt(map: MapLibreMap, point: { x: number; y: number }): MapPoi | null {
    const layers = Object.values(POI_LAYERS).filter(
      (id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') === 'visible',
    );
    if (layers.length === 0) return null;
    // A fingertip is bigger than the icon.
    const pad = 14;
    const hit = map.queryRenderedFeatures(
      [
        [point.x - pad, point.y - pad],
        [point.x + pad, point.y + pad],
      ],
      { layers },
    )[0];
    if (!hit || hit.geometry.type !== 'Point') return null;
    const props = hit.properties ?? {};
    const osm = hit.layer.id === POI_LAYERS.osmFuel || hit.layer.id === POI_LAYERS.osmFood;
    const kind: MapPoi['kind'] =
      hit.layer.id === POI_LAYERS.fuel || hit.layer.id === POI_LAYERS.osmFuel ? 'fuel' : 'food';
    const name = String((osm ? props['name:latin'] ?? props.name : props.name) ?? '').trim();
    const [lon, lat] = hit.geometry.coordinates as [number, number];
    return {
      name: name || (kind === 'fuel' ? 'Fuel station' : 'Place to eat'),
      kind,
      coordinate: [lon, lat],
      source: osm ? 'OpenStreetMap' : String(props.source ?? 'Overture Maps'),
    };
  }

  private showPoiPopup(map: MapLibreMap, poi: MapPoi): void {
    this.poiPopup?.remove();
    const el = document.createElement('div');
    el.className = 'tc-poi-popup-body';
    const title = document.createElement('strong');
    title.textContent = poi.name;
    const sub = document.createElement('span');
    sub.textContent = `${poi.kind === 'fuel' ? 'Fuel station' : 'Place to eat'} · ${poi.source}`;
    el.append(title, sub);
    const popup = new Popup({ closeButton: true, offset: 14, className: 'tc-poi-popup', maxWidth: '240px' });
    if (this.poiActions.length > 0) {
      const actions = document.createElement('div');
      actions.className = 'tc-poi-popup-actions';
      for (const action of this.poiActions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = action === 'stop' ? 'tc-btn tc-btn-sm tc-btn-secondary' : 'tc-btn tc-btn-sm';
        button.textContent = POI_ACTION_LABELS[action];
        button.addEventListener('click', () => {
          popup.remove();
          for (const listener of this.poiActionListeners) listener(poi, action);
        });
        actions.append(button);
      }
      el.append(actions);
    }
    this.poiPopupKind = poi.kind;
    this.poiPopup = popup.setLngLat(poi.coordinate).setDOMContent(el).addTo(map);
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

function readOverlayPreference(): MapOverlaySettings {
  const settings: MapOverlaySettings = { shown: true, fuel: true, food: true };
  try {
    const saved = JSON.parse(localStorage.getItem(OVERLAY_PREF_KEY) ?? 'null') as unknown;
    if (saved && typeof saved === 'object') {
      for (const key of Object.keys(settings) as Array<keyof MapOverlaySettings>) {
        const value = (saved as Record<string, unknown>)[key];
        if (typeof value === 'boolean') settings[key] = value;
      }
    } else if (localStorage.getItem(OLD_POI_PREF_KEY) === '0') {
      settings.shown = false;
    }
  } catch {
    // Defaults.
  }
  return settings;
}

function poiIconName(kind: 'fuel' | 'food'): string {
  return `tc-poi-${kind}`;
}

/** Glyphs on a 24-unit grid, stroked white on the pin's colour. */
export const POI_GLYPHS = {
  fuel: 'M6 20V5.5A1.5 1.5 0 0 1 7.5 4h5A1.5 1.5 0 0 1 14 5.5V20M4.5 20h11M8 7.5h4v3H8zM14 11h1.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 0 3 0V9l-2.5-2.5',
  food: 'M8 3.5v6M5.5 3.5v4a2.5 2.5 0 0 0 5 0v-4M8 9.5V20.5M17 20.5V3.5c-2 1.2-3 3.6-3 7.5h3',
};

/** A 24 px round badge (48 px drawn, for sharp icons on 2x screens). */
function drawPoiIcon(kind: 'fuel' | 'food'): ImageData {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
  ctx.fillStyle = POI_COLORS[kind];
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#1a1205';
  ctx.stroke();
  ctx.save();
  const scale = 1.25;
  ctx.translate(size / 2 - 12 * scale, size / 2 - 12 * scale);
  ctx.scale(scale, scale);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(POI_GLYPHS[kind]));
  ctx.restore();
  return ctx.getImageData(0, 0, size, size);
}

export const mapService = new MapLibreAdapter();
