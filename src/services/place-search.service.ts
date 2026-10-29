import type { Coordinate } from '../routing/routing-adapter';
import { haversineMeters } from '../routing/geo';
import type { AreaShape } from '../offline/tile-plan';
import type { PlaceHit } from '../types/trip-stop';
import { nominatimSearch } from './nominatim-client';

/**
 * Geocode a free-text place query via Nominatim (OSM).
 * Requires network; respect OSM usage policy (light interactive use).
 */
export async function searchPlaces(
  query: string,
  near?: Coordinate | null,
  limit = 8,
): Promise<PlaceHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const params: Record<string, string> = {
    q: trimmed,
    addressdetails: '0',
    limit: String(limit),
  };
  if (near) {
    params.viewbox = viewboxAround(near, 0.6);
    params.bounded = '0';
  }

  let data;
  try {
    data = await nominatimSearch(params);
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    throw new Error(`Place search failed (${detail})`);
  }
  const hits: PlaceHit[] = data.map((row) => {
    const coordinate: Coordinate = [Number(row.lon), Number(row.lat)];
    const name =
      row.name?.trim() ||
      row.display_name.split(',')[0]?.trim() ||
      'Place';
    return {
      id: `nom-${row.place_id}`,
      name,
      coordinate,
      subtitle: row.display_name,
      distanceMeters: near ? haversineMeters(near, coordinate) : undefined,
    };
  });

  if (near) {
    hits.sort(
      (a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0),
    );
  }
  return hits;
}

function viewboxAround(center: Coordinate, deg: number): string {
  const [lon, lat] = center;
  const west = lon - deg;
  const east = lon + deg;
  const south = lat - deg;
  const north = lat + deg;
  return `${west},${north},${east},${south}`;
}

export interface AreaHit {
  /** OpenStreetMap's id, e.g. "R1950884", the same on every phone. */
  key: string;
  name: string;
  /** "State", "City", "District"… */
  kind: string;
  subtitle: string;
  shape: AreaShape;
}

/**
 * Cities, districts, states and other places with an outline, for saving
 * an area's map. Outlines are simplified to about 500 m.
 */
export async function searchAreas(query: string, signal?: AbortSignal): Promise<AreaHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  let rows;
  try {
    rows = await nominatimSearch(
      {
        q: trimmed,
        layer: 'address',
        limit: '6',
        polygon_geojson: '1',
        polygon_threshold: '0.005',
      },
      signal,
    );
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    throw new Error(`Area search failed (${detail})`);
  }
  return rows.flatMap((row) => {
    const box = row.boundingbox?.map(Number);
    if (!box || box.length !== 4 || box.some(Number.isNaN) || !row.osm_type || row.osm_id == null) return [];
    const [south, north, west, east] = box as [number, number, number, number];
    const polygons =
      row.geojson?.type === 'Polygon'
        ? [row.geojson.coordinates as Coordinate[][]]
        : row.geojson?.type === 'MultiPolygon'
          ? (row.geojson.coordinates as Coordinate[][][])
          : undefined;
    const kind = (row.addresstype ?? row.type ?? 'place').replace(/_/g, ' ');
    return [
      {
        key: `${row.osm_type[0]!.toUpperCase()}${row.osm_id}`,
        name: row.name?.trim() || row.display_name.split(',')[0]?.trim() || 'Area',
        kind: kind.charAt(0).toUpperCase() + kind.slice(1),
        subtitle: row.display_name,
        shape: { bbox: [west, south, east, north], ...(polygons ? { polygons } : {}) },
      },
    ];
  });
}
