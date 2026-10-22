import type { CalculatedRoute, Coordinate } from '../routing/routing-adapter';
import {
  distanceAlongPolylineMeters,
  pointAlongPolylineMeters,
  pointsAlongPolylineEveryMeters,
  polylineLengthMeters,
} from '../routing/geo';
import { formatDistanceShort } from '../routing/route-naming';
import { findPois } from './poi-search.service';
import type { PlaceHit, PoiKind } from '../types/trip-stop';

/** Use this fraction of a full tank before planning the next fill. */
export const FUEL_RANGE_BUFFER = 0.7;
const FUEL_SEARCH_RADIUS_M = 5_000;
const FOOD_SEARCH_RADIUS_M = 4_000;

export type MealKind = 'breakfast' | 'lunch' | 'dinner';

export interface MealWindow {
  id: MealKind;
  label: string;
  /** Local minutes from midnight — window start. */
  startMinutes: number;
  /** Local minutes from midnight — window end. */
  endMinutes: number;
  /** Preferred center of the window for ETA targeting. */
  targetMinutes: number;
}

export const MEAL_WINDOWS: MealWindow[] = [
  {
    id: 'breakfast',
    label: 'Breakfast',
    startMinutes: 7 * 60,
    endMinutes: 10 * 60,
    targetMinutes: 8 * 60 + 30,
  },
  {
    id: 'lunch',
    label: 'Lunch',
    startMinutes: 12 * 60,
    endMinutes: 14 * 60 + 30,
    targetMinutes: 13 * 60,
  },
  {
    id: 'dinner',
    label: 'Dinner',
    startMinutes: 18 * 60 + 30,
    endMinutes: 21 * 60,
    targetMinutes: 19 * 60 + 30,
  },
];

export interface StopSuggestion {
  id: string;
  kind: PoiKind;
  place: PlaceHit;
  /** Why this was suggested (tank distance / meal). */
  reason: string;
  alongMeters: number;
  meal?: MealKind;
}

const PREFS_TANK = 'tc.tankRangeKm';
const PREFS_DEPART = 'tc.departTime';
const PREFS_MEALS = 'tc.mealKinds';

export function loadTankRangeKm(fallback = 250): number {
  try {
    const raw = localStorage.getItem(PREFS_TANK);
    const n = raw != null ? Number(raw) : fallback;
    if (!Number.isFinite(n) || n < 40 || n > 1200) return fallback;
    return Math.round(n);
  } catch {
    return fallback;
  }
}

export function saveTankRangeKm(km: number): void {
  try {
    localStorage.setItem(PREFS_TANK, String(Math.round(km)));
  } catch {
    // ignore
  }
}

export function loadDepartTime(fallback?: string): string {
  const fb =
    fallback ??
    (() => {
      const d = new Date();
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    })();
  try {
    const raw = localStorage.getItem(PREFS_DEPART);
    if (raw && /^\d{1,2}:\d{2}$/.test(raw)) return normalizeTime(raw);
    return fb;
  } catch {
    return fb;
  }
}

export function saveDepartTime(value: string): void {
  try {
    localStorage.setItem(PREFS_DEPART, normalizeTime(value));
  } catch {
    // ignore
  }
}

export function loadMealKinds(
  fallback: MealKind[] = ['lunch', 'dinner'],
): MealKind[] {
  try {
    const raw = localStorage.getItem(PREFS_MEALS);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    const allowed = new Set(MEAL_WINDOWS.map((m) => m.id));
    const next = parsed.filter(
      (x): x is MealKind => typeof x === 'string' && allowed.has(x as MealKind),
    );
    return next.length > 0 ? next : fallback;
  } catch {
    return fallback;
  }
}

export function saveMealKinds(meals: MealKind[]): void {
  try {
    localStorage.setItem(PREFS_MEALS, JSON.stringify(meals));
  } catch {
    // ignore
  }
}

/**
 * Suggest fuel stations spaced by usable tank range along the route.
 */
export async function suggestFuelStops(options: {
  route: CalculatedRoute;
  tankRangeKm: number;
  buffer?: number;
  existingCoordinates?: Coordinate[];
}): Promise<StopSuggestion[]> {
  const routeCoords = options.route.coordinates;
  if (routeCoords.length < 2) {
    throw new Error('Preview a route first so fuel can be spaced along it');
  }

  const buffer = options.buffer ?? FUEL_RANGE_BUFFER;
  const intervalM = Math.max(25_000, options.tankRangeKm * 1000 * buffer);
  const total = polylineLengthMeters(routeCoords);
  if (total < intervalM * 0.4) {
    return [];
  }

  const checkpoints = pointsAlongPolylineEveryMeters(routeCoords, intervalM);
  const suggestions: StopSuggestion[] = [];
  const used = new Set<string>();
  markExisting(used, options.existingCoordinates);

  for (const cp of checkpoints) {
    const hits = await findPois({
      kind: 'fuel',
      near: cp.coordinate,
      radiusMeters: FUEL_SEARCH_RADIUS_M,
      limit: 10,
    });
    const best = pickBestAlongRoute(hits, routeCoords, used);
    if (!best) continue;
    used.add(placeKey(best));
    suggestions.push({
      id: `fuel-${suggestions.length}-${best.id}`,
      kind: 'fuel',
      place: best,
      alongMeters: cp.alongMeters,
      reason: `Fill around ${formatDistanceShort(cp.alongMeters)} (≈${Math.round(options.tankRangeKm * buffer)} km tank legs)`,
    });
  }

  return suggestions;
}

/**
 * Suggest food stops where the rider is expected to be during meal windows.
 */
export async function suggestFoodStops(options: {
  route: CalculatedRoute;
  departTime: string;
  meals: MealKind[];
  existingCoordinates?: Coordinate[];
}): Promise<StopSuggestion[]> {
  const routeCoords = options.route.coordinates;
  if (routeCoords.length < 2) {
    throw new Error('Preview a route first so meals can match your ETA');
  }
  if (options.meals.length === 0) return [];

  const departMinutes = parseTimeToMinutes(options.departTime);
  const durationSec = Math.max(1, options.route.durationSeconds);
  const totalM = polylineLengthMeters(routeCoords);
  const arriveMinutes = departMinutes + durationSec / 60;

  const suggestions: StopSuggestion[] = [];
  const used = new Set<string>();
  markExisting(used, options.existingCoordinates);

  for (const mealId of options.meals) {
    const window = MEAL_WINDOWS.find((m) => m.id === mealId);
    if (!window) continue;

    const target = mealTargetDuringTrip(
      window,
      departMinutes,
      arriveMinutes,
    );
    if (target == null) continue;

    const elapsedMin = target - departMinutes;
    const alongMeters = Math.min(
      totalM * 0.95,
      Math.max(totalM * 0.05, (elapsedMin / (durationSec / 60)) * totalM),
    );
    const onRoute = pointAlongPolylineMeters(routeCoords, alongMeters);
    if (!onRoute) continue;

    const hits = await findPois({
      kind: 'food',
      near: onRoute.coordinate,
      radiusMeters: FOOD_SEARCH_RADIUS_M,
      limit: 12,
    });
    const best = pickBestAlongRoute(hits, routeCoords, used);
    if (!best) continue;
    used.add(placeKey(best));

    const clock = formatMinutes(target);
    suggestions.push({
      id: `food-${mealId}-${best.id}`,
      kind: 'food',
      place: best,
      alongMeters: onRoute.alongMeters,
      meal: mealId,
      reason: `${window.label} near ${clock} · ${formatDistanceShort(onRoute.alongMeters)} into the trip`,
    });
  }

  return suggestions;
}

function mealTargetDuringTrip(
  window: MealWindow,
  departMinutes: number,
  arriveMinutes: number,
): number | null {
  // Same calendar day approximation; wrap past midnight for long rides.
  const candidates: number[] = [];
  for (const dayOffset of [0, 1]) {
    const start = window.startMinutes + dayOffset * 24 * 60;
    const end = window.endMinutes + dayOffset * 24 * 60;
    const target = window.targetMinutes + dayOffset * 24 * 60;
    if (end < departMinutes || start > arriveMinutes) continue;
    const clamped = Math.min(Math.max(target, departMinutes), arriveMinutes);
    if (clamped >= start && clamped <= end) candidates.push(clamped);
    else if (departMinutes <= end && arriveMinutes >= start) {
      candidates.push(
        Math.min(Math.max(target, Math.max(start, departMinutes)), Math.min(end, arriveMinutes)),
      );
    }
  }
  if (candidates.length === 0) return null;
  // Prefer the first meal window that overlaps the trip.
  return candidates[0]!;
}

function pickBestAlongRoute(
  hits: PlaceHit[],
  route: Coordinate[],
  used: Set<string>,
): PlaceHit | null {
  let best: PlaceHit | null = null;
  let bestScore = Infinity;
  for (const hit of hits) {
    const key = placeKey(hit);
    if (used.has(key)) continue;
    const off = distanceAlongPolylineMeters(
      hit.coordinate,
      route,
    ).distanceToRouteMeters;
    const score = off + (hit.distanceMeters ?? 0) * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = { ...hit, distanceMeters: off };
    }
  }
  return best;
}

function placeKey(hit: PlaceHit): string {
  return `${hit.coordinate[0].toFixed(4)},${hit.coordinate[1].toFixed(4)}`;
}

function markExisting(used: Set<string>, coords?: Coordinate[]): void {
  for (const c of coords ?? []) {
    used.add(`${c[0].toFixed(4)},${c[1].toFixed(4)}`);
  }
}

function parseTimeToMinutes(value: string): number {
  const [h, m] = normalizeTime(value).split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function normalizeTime(value: string): string {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  const h = Math.min(23, Math.max(0, Number(match[1])));
  const m = Math.min(59, Math.max(0, Number(match[2])));
  return `${pad2(h)}:${pad2(m)}`;
}

function formatMinutes(total: number): string {
  const wrapped = ((Math.round(total) % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
