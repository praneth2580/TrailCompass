import type { Coordinate } from './routing-adapter';
import type { SavedPlaces, SavedRoute, TrailCompassRouteFile } from '../types/route';

export const ROUTE_FILE_FORMAT = 'trailcompass-route' as const;
export const ROUTE_FILE_VERSION = 1 as const;
export const ROUTE_FILE_EXTENSION = '.trailcompass.json';

export function toRouteFile(route: SavedRoute): TrailCompassRouteFile {
  return {
    format: ROUTE_FILE_FORMAT,
    version: ROUTE_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'trailcompass',
    route,
  };
}

export function serializeRouteFile(route: SavedRoute): string {
  return `${JSON.stringify(toRouteFile(route), null, 2)}\n`;
}

export function parseRouteFile(raw: string): SavedRoute {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Not a valid route file (invalid JSON)');
  }

  // Accept bare SavedRoute for flexibility, or the envelope.
  if (isTrailCompassRouteFile(data)) {
    return normalizeSavedRoute(data.route);
  }
  if (isLooseSavedRoute(data)) {
    return normalizeSavedRoute(data);
  }
  if (isGeoJsonLineString(data)) {
    return savedFromGeoJson(data);
  }

  throw new Error('Unrecognized route file format');
}

export function toGeoJson(route: SavedRoute): string {
  const feature = {
    type: 'Feature',
    properties: {
      name: route.name,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      profile: route.profile ?? null,
      trailcompassId: route.id,
    },
    geometry: {
      type: 'LineString',
      coordinates: route.coordinates,
    },
  };
  return `${JSON.stringify(feature, null, 2)}\n`;
}

export function suggestedFileName(route: SavedRoute): string {
  const slug = route.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${slug || 'route'}${ROUTE_FILE_EXTENSION}`;
}

function isTrailCompassRouteFile(data: unknown): data is TrailCompassRouteFile {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  return (
    o.format === ROUTE_FILE_FORMAT &&
    o.version === ROUTE_FILE_VERSION &&
    isLooseSavedRoute(o.route)
  );
}

function isLooseSavedRoute(data: unknown): data is SavedRoute {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    Array.isArray(o.coordinates) &&
    o.coordinates.length >= 2 &&
    typeof o.distanceMeters === 'number'
  );
}

function isGeoJsonLineString(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  if (o.type === 'Feature') {
    const g = o.geometry as Record<string, unknown> | undefined;
    return g?.type === 'LineString' && Array.isArray(g.coordinates);
  }
  return o.type === 'LineString' && Array.isArray(o.coordinates);
}

function savedFromGeoJson(data: unknown): SavedRoute {
  const o = data as Record<string, unknown>;
  const geometry =
    o.type === 'Feature'
      ? (o.geometry as { coordinates: Coordinate[] })
      : (o as { coordinates: Coordinate[] });
  const props =
    o.type === 'Feature' && o.properties && typeof o.properties === 'object'
      ? (o.properties as Record<string, unknown>)
      : {};
  const coordinates = geometry.coordinates as Coordinate[];
  const now = new Date().toISOString();
  return normalizeSavedRoute({
    id: String(props.trailcompassId ?? crypto.randomUUID()),
    name: String(props.name ?? 'Imported GeoJSON'),
    createdAt: now,
    updatedAt: now,
    start: coordinates[0]!,
    end: coordinates[coordinates.length - 1]!,
    waypoints: [],
    coordinates,
    distanceMeters: Number(props.distanceMeters ?? 0),
    durationSeconds: Number(props.durationSeconds ?? 0),
    instructions: [],
  });
}

function normalizeSavedRoute(route: SavedRoute): SavedRoute {
  const coords = route.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new Error('Route needs at least two coordinates');
  }
  const now = new Date().toISOString();
  return {
    id: route.id || crypto.randomUUID(),
    name: route.name || 'Imported route',
    createdAt: route.createdAt || now,
    // Kept, so an import can tell which copy of a trip is newer.
    updatedAt: validDate(route.updatedAt) ?? validDate(route.createdAt) ?? now,
    start: route.start ?? coords[0]!,
    end: route.end ?? coords[coords.length - 1]!,
    waypoints: Array.isArray(route.waypoints) ? route.waypoints : [],
    coordinates: coords,
    distanceMeters: Number(route.distanceMeters) || 0,
    durationSeconds: Number(route.durationSeconds) || 0,
    instructions: Array.isArray(route.instructions) ? route.instructions : [],
    profile: route.profile,
    label: route.label,
    ...(placesFor(route) ? { places: placesFor(route) } : {}),
  };
}

function validDate(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/** Stop names from a file, only if they match its stops; else none. */
function placesFor(route: SavedRoute): SavedPlaces | undefined {
  const places = route.places as unknown;
  if (!places || typeof places !== 'object') return undefined;
  const { end, endNotes, stops } = places as { end?: unknown; endNotes?: unknown; stops?: unknown };
  const waypoints = Array.isArray(route.waypoints) ? route.waypoints.length : 0;
  const named =
    Array.isArray(stops) &&
    stops.length === waypoints &&
    stops.every(
      (stop) =>
        stop != null &&
        typeof stop.name === 'string' &&
        ['fuel', 'food', 'manual'].includes(stop.kind) &&
        (stop.notes == null || typeof stop.notes === 'string'),
    )
      ? (stops as NonNullable<SavedPlaces['stops']>).map((stop) => ({
          name: stop.name.slice(0, 120),
          kind: stop.kind,
          ...(stop.notes ? { notes: stop.notes.slice(0, 200) } : {}),
        }))
      : undefined;
  const endName = typeof end === 'string' && end.trim() ? end.slice(0, 120) : undefined;
  const endLine = typeof endNotes === 'string' && endNotes.trim() ? endNotes.slice(0, 200) : undefined;
  if (!named && !endName) return undefined;
  return {
    ...(endName ? { end: endName } : {}),
    ...(endName && endLine ? { endNotes: endLine } : {}),
    ...(named ? { stops: named } : {}),
  };
}
