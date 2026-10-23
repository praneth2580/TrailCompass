import type { Coordinate } from '../routing/routing-adapter';
import { haversineMeters } from '../routing/geo';
import type { PlaceHit } from '../types/trip-stop';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
/** Nominatim's usage policy allows at most one request per second. */
const NOMINATIM_MIN_INTERVAL_MS = 1_000;

let nextRequestAt = 0;

async function waitForNominatimSlot(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + NOMINATIM_MIN_INTERVAL_MS;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  name?: string;
  type?: string;
  class?: string;
}

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

  const params = new URLSearchParams({
    q: trimmed,
    format: 'jsonv2',
    addressdetails: '0',
    limit: String(limit),
  });
  if (near) {
    params.set('viewbox', viewboxAround(near, 0.6));
    params.set('bounded', '0');
  }

  await waitForNominatimSlot();
  const response = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Place search failed (${response.status})`);
  }

  const data = (await response.json()) as NominatimResult[];
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
