import type { CalculatedRoute, Coordinate } from '../routing/routing-adapter';
import {
  distanceAlongPolylineMeters,
  pointAlongPolylineMeters,
  polylineLengthMeters,
  samplePolylineMeters,
} from '../routing/geo';
import { isAbortError } from '../routing/abort';
import { formatDistanceShort } from '../routing/route-naming';
import { findPois, isGenericName } from './poi-search.service';
import type { PlaceHit, PoiKind } from '../types/trip-stop';

/** Use this fraction of a full tank before planning the next fill. */
export const FUEL_RANGE_BUFFER = 0.7;
/** Look for a pump from this share of a tank leg onward (not too early)… */
const FUEL_WINDOW_START = 0.5;
/** …up to this share past the leg's end (eating into the 30% reserve). */
const FUEL_WINDOW_OVERRUN = 0.05;
/** How far off the route a pump may be. */
const FUEL_SEARCH_RADIUS_M = 2_500;
/** Look for food this far before and after where the meal falls. */
const FOOD_WINDOW_M = 15_000;
const FOOD_SEARCH_RADIUS_M = 1_500;
/** Route stretches are sampled this finely for the corridor search. */
const STRETCH_STEP_M = 1_000;

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

export interface SuggestOutcome {
  suggestions: StopSuggestion[];
  /** Explains an empty or partial result (e.g. no stop needed, a gap). */
  note?: string;
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
 * Each fill is searched over the last stretch of its tank leg, and the
 * next leg starts from the pump actually picked.
 */
export async function suggestFuelStops(options: {
  route: CalculatedRoute;
  tankRangeKm: number;
  buffer?: number;
  existingCoordinates?: Coordinate[];
  signal?: AbortSignal;
}): Promise<SuggestOutcome> {
  const routeCoords = options.route.coordinates;
  if (routeCoords.length < 2) {
    throw new Error('Preview a route first so fuel can be spaced along it');
  }

  const buffer = options.buffer ?? FUEL_RANGE_BUFFER;
  const legM = Math.max(25_000, options.tankRangeKm * 1000 * buffer);
  const totalM = polylineLengthMeters(routeCoords);
  if (totalM <= legM) {
    return {
      suggestions: [],
      note: `This ${formatDistanceShort(totalM)} trip fits in one tank leg (${formatDistanceShort(legM)}, 70% of your range) — no fuel stop needed. Use Browse list to add one anyway.`,
    };
  }

  const suggestions: StopSuggestion[] = [];
  const used = new Set<string>();
  markExisting(used, options.existingCoordinates);
  const gaps: number[] = [];
  let searchError: unknown = null;
  let lastFillM = 0;

  while (lastFillM + legM < totalM) {
    const targetM = lastFillM + legM;
    const fromM = lastFillM + legM * FUEL_WINDOW_START;
    const toM = Math.min(totalM, targetM + legM * FUEL_WINDOW_OVERRUN);
    const stretch = samplePolylineMeters(routeCoords, fromM, toM, STRETCH_STEP_M);

    let hits: PlaceHit[] = [];
    try {
      hits = await findPois({
        kind: 'fuel',
        route: stretch.map((p) => p.coordinate),
        radiusMeters: FUEL_SEARCH_RADIUS_M,
        limit: 40,
        signal: options.signal,
      });
    } catch (e) {
      if (isAbortError(e)) throw e;
      searchError = e;
    }

    const best = pickBest(hits, stretch, used, (alongM) =>
      alongM <= targetM
        ? (targetM - alongM) * 0.02
        : (alongM - targetM) * 0.2,
    );
    if (!best) {
      gaps.push(targetM);
      lastFillM = targetM;
      continue;
    }

    used.add(placeKey(best.place));
    const sinceLabel = lastFillM === 0 ? 'from the start' : 'after the last fill';
    suggestions.push({
      id: `fuel-${suggestions.length}-${best.place.id}`,
      kind: 'fuel',
      place: best.place,
      alongMeters: best.alongMeters,
      reason: `${formatDistanceShort(best.alongMeters)} into the trip · ${formatDistanceShort(best.alongMeters - lastFillM)} ${sinceLabel}`,
    });
    lastFillM = best.alongMeters;
  }

  if (suggestions.length === 0 && searchError) throw searchError;
  return {
    suggestions,
    note:
      gaps.length > 0
        ? `No station found near ${gaps.map((m) => formatDistanceShort(m)).join(', ')} — fill up earlier there.`
        : undefined,
  };
}

/**
 * Suggest food stops where the rider is expected to be during meal windows.
 */
export async function suggestFoodStops(options: {
  route: CalculatedRoute;
  departTime: string;
  meals: MealKind[];
  existingCoordinates?: Coordinate[];
  signal?: AbortSignal;
}): Promise<SuggestOutcome> {
  const routeCoords = options.route.coordinates;
  if (routeCoords.length < 2) {
    throw new Error('Preview a route first so meals can match your ETA');
  }
  if (options.meals.length === 0) {
    return { suggestions: [], note: 'Pick at least one meal' };
  }

  const departMinutes = parseTimeToMinutes(options.departTime);
  const durationSec = Math.max(1, options.route.durationSeconds);
  const totalM = polylineLengthMeters(routeCoords);
  const arriveMinutes = departMinutes + durationSec / 60;

  const suggestions: StopSuggestion[] = [];
  const used = new Set<string>();
  markExisting(used, options.existingCoordinates);
  const missed: string[] = [];
  let mealsDuringTrip = 0;
  let searchError: unknown = null;

  for (const mealId of options.meals) {
    const window = MEAL_WINDOWS.find((m) => m.id === mealId);
    if (!window) continue;

    const target = mealTargetDuringTrip(
      window,
      departMinutes,
      arriveMinutes,
    );
    if (target == null) continue;
    mealsDuringTrip += 1;

    const elapsedMin = target - departMinutes;
    const alongMeters = Math.min(
      totalM * 0.95,
      Math.max(totalM * 0.05, (elapsedMin / (durationSec / 60)) * totalM),
    );
    const onRoute = pointAlongPolylineMeters(routeCoords, alongMeters);
    if (!onRoute) continue;
    const stretch = samplePolylineMeters(
      routeCoords,
      onRoute.alongMeters - FOOD_WINDOW_M,
      onRoute.alongMeters + FOOD_WINDOW_M,
      STRETCH_STEP_M,
    );

    let hits: PlaceHit[] = [];
    try {
      hits = await findPois({
        kind: 'food',
        route: stretch.map((p) => p.coordinate),
        radiusMeters: FOOD_SEARCH_RADIUS_M,
        limit: 40,
        signal: options.signal,
      });
    } catch (e) {
      if (isAbortError(e)) throw e;
      searchError = e;
    }

    const best = pickBest(
      hits,
      stretch,
      used,
      (along) => Math.abs(along - onRoute.alongMeters) * 0.05,
    );
    if (!best) {
      missed.push(window.label.toLowerCase());
      continue;
    }
    used.add(placeKey(best.place));

    const clock = formatMinutes(target);
    suggestions.push({
      id: `food-${mealId}-${best.place.id}`,
      kind: 'food',
      place: best.place,
      alongMeters: best.alongMeters,
      meal: mealId,
      reason: `${window.label} near ${clock} · ${formatDistanceShort(best.alongMeters)} into the trip`,
    });
  }

  if (suggestions.length === 0 && searchError) throw searchError;
  if (mealsDuringTrip === 0) {
    return {
      suggestions,
      note: 'None of the chosen meal times fall during this trip — change the departure time or meals',
    };
  }
  return {
    suggestions,
    note:
      missed.length > 0
        ? `No places to eat found on the route around ${missed.join(' or ')} time`
        : undefined,
  };
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

/**
 * Lowest score wins: metres off the route, plus `positionPenalty` for where
 * along the trip it sits, plus a little for places with no name.
 */
function pickBest(
  hits: PlaceHit[],
  stretch: Array<{ coordinate: Coordinate; alongMeters: number }>,
  used: Set<string>,
  positionPenalty: (alongMeters: number) => number,
): { place: PlaceHit; alongMeters: number } | null {
  if (stretch.length < 2) return null;
  const line = stretch.map((p) => p.coordinate);
  const startM = stretch[0]!.alongMeters;

  let best: { place: PlaceHit; alongMeters: number } | null = null;
  let bestScore = Infinity;
  for (const hit of hits) {
    if (used.has(placeKey(hit))) continue;
    const projection = distanceAlongPolylineMeters(hit.coordinate, line);
    const alongMeters = startM + projection.alongMeters;
    const score =
      projection.distanceToRouteMeters +
      positionPenalty(alongMeters) +
      (isGenericName(hit.name) ? 500 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = {
        place: { ...hit, distanceMeters: projection.distanceToRouteMeters },
        alongMeters,
      };
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
