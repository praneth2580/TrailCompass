import { useEffect, useId, useRef, useState } from 'react';
import type { CalculatedRoute, Coordinate } from '../routing/routing-adapter';
import { formatDistanceShort } from '../routing/route-naming';
import {
  createTripStop,
  type PoiKind,
  type TripStop,
} from '../types/trip-stop';
import {
  FUEL_RANGE_BUFFER,
  MEAL_WINDOWS,
  loadDepartTime,
  loadMealKinds,
  loadTankRangeKm,
  saveDepartTime,
  saveMealKinds,
  saveTankRangeKm,
  suggestFoodStops,
  suggestFuelStops,
  type MealKind,
  type StopSuggestion,
} from '../services/stop-suggest.service';

type SuggestPhase = 'idle' | 'routing' | 'searching';

interface StopSuggestSheetProps {
  open: boolean;
  kind: PoiKind;
  route: CalculatedRoute | null;
  /** True when a route can be planned on demand (destination set, engine ready). */
  canPlanRoute: boolean;
  /** Road-download / routing progress while planning on demand. */
  planningLabel?: string;
  existingCoordinates?: Coordinate[];
  /** Plan the trip in place; resolves null if superseded, throws on error. */
  onEnsureRoute: () => Promise<CalculatedRoute | null>;
  onClose: () => void;
  onPick: (stop: TripStop) => void;
  onBrowse: () => void;
}

export function StopSuggestSheet({
  open,
  kind,
  route,
  canPlanRoute,
  planningLabel,
  existingCoordinates,
  onEnsureRoute,
  onClose,
  onPick,
  onBrowse,
}: StopSuggestSheetProps) {
  const titleId = useId();
  const sessionKey = open ? kind : '';
  const [session, setSession] = useState(sessionKey);
  const [tankKm, setTankKm] = useState(() => loadTankRangeKm());
  const [departTime, setDepartTime] = useState(() => loadDepartTime());
  const [meals, setMeals] = useState<MealKind[]>(() => loadMealKinds());
  const [suggestions, setSuggestions] = useState<StopSuggestion[]>([]);
  const [phase, setPhase] = useState<SuggestPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(() => new Set());
  // Bumped whenever the sheet closes or switches kind so late results drop.
  const runToken = useRef(0);

  const busy = phase !== 'idle';
  const hasRoute = route != null && route.coordinates.length >= 2;

  if (sessionKey !== session) {
    setSession(sessionKey);
    setSuggestions([]);
    setPhase('idle');
    setError(null);
    setAddedIds(new Set());
    setTankKm(loadTankRangeKm());
    setDepartTime(loadDepartTime());
    setMeals(loadMealKinds());
  }

  useEffect(() => {
    runToken.current += 1;
  }, [sessionKey]);

  async function runSuggest() {
    const token = runToken.current;
    const stale = () => token !== runToken.current;

    setError(null);
    setSuggestions([]);
    try {
      let target: CalculatedRoute | null = hasRoute ? route : null;
      if (!target) {
        setPhase('routing');
        target = await onEnsureRoute();
        if (stale()) return;
        if (!target) {
          setError('Trip changed while planning — tap Suggest stops again');
          return;
        }
      }

      setPhase('searching');
      if (kind === 'fuel') {
        saveTankRangeKm(tankKm);
        const next = await suggestFuelStops({
          route: target,
          tankRangeKm: tankKm,
          existingCoordinates,
        });
        if (stale()) return;
        setSuggestions(next);
        if (next.length === 0) {
          setError(
            'Trip is shorter than a tank leg, or no stations found at fill points',
          );
        }
      } else {
        saveDepartTime(departTime);
        saveMealKinds(meals);
        const next = await suggestFoodStops({
          route: target,
          departTime,
          meals,
          existingCoordinates,
        });
        if (stale()) return;
        setSuggestions(next);
        if (next.length === 0) {
          setError(
            'No meal windows fall during this trip, or no places near those ETAs',
          );
        }
      }
    } catch (e) {
      if (stale()) return;
      setError(e instanceof Error ? e.message : 'Suggestion failed');
    } finally {
      if (!stale()) setPhase('idle');
    }
  }

  if (!open) return null;

  const title = kind === 'fuel' ? 'Fuel by tank range' : 'Food by time of day';
  const hint =
    kind === 'fuel'
      ? `Stations are spaced at about ${Math.round(tankKm * FUEL_RANGE_BUFFER)} km (70% of your tank).`
      : 'Places are picked where you should be during breakfast, lunch, or dinner.';

  const toggleMeal = (id: MealKind) => {
    setMeals((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );
  };

  const addSuggestion = (item: StopSuggestion) => {
    onPick(
      createTripStop(
        item.kind,
        item.place.coordinate,
        item.place.name,
        item.reason,
      ),
    );
    setAddedIds((prev) => new Set(prev).add(item.id));
  };

  return (
    <div className="tc-sheet-root" role="presentation">
      <button
        type="button"
        className="tc-sheet-backdrop"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        className="tc-sheet tc-sheet-tall"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="tc-sheet-handle" aria-hidden />
        <header className="tc-sheet-header">
          <h2 id={titleId} className="tc-sheet-title">
            {title}
          </h2>
          <p className="tc-sheet-hint">{hint}</p>
        </header>

        {kind === 'fuel' ? (
          <label className="tc-sheet-field">
            <span className="tc-sheet-label">Tank range (km)</span>
            <input
              className="tc-sheet-input"
              type="number"
              inputMode="numeric"
              min={40}
              max={1200}
              step={10}
              value={tankKm}
              onChange={(e) => setTankKm(Number(e.target.value) || 0)}
            />
          </label>
        ) : (
          <>
            <label className="tc-sheet-field">
              <span className="tc-sheet-label">Depart at</span>
              <input
                className="tc-sheet-input"
                type="time"
                value={departTime}
                onChange={(e) => setDepartTime(e.target.value)}
              />
            </label>
            <div className="tc-plan-meal-toggles" role="group" aria-label="Meals">
              {MEAL_WINDOWS.map((meal) => {
                const on = meals.includes(meal.id);
                return (
                  <button
                    key={meal.id}
                    type="button"
                    className={
                      on
                        ? 'tc-plan-scope-btn tc-plan-scope-btn-active'
                        : 'tc-plan-scope-btn'
                    }
                    aria-pressed={on}
                    onClick={() => toggleMeal(meal.id)}
                  >
                    {meal.label}
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="tc-plan-quick-actions">
          <button
            type="button"
            className="tc-btn"
            disabled={busy || (!hasRoute && !canPlanRoute)}
            onClick={() => void runSuggest()}
          >
            {phase === 'routing'
              ? 'Planning route…'
              : phase === 'searching'
                ? 'Finding…'
                : 'Suggest stops'}
          </button>
          <button
            type="button"
            className="tc-btn tc-btn-secondary"
            onClick={onBrowse}
          >
            Browse list
          </button>
        </div>

        <div className="tc-plan-hit-list" role="listbox" aria-label="Suggestions">
          {phase === 'routing' ? (
            <p className="tc-plan-hit-empty">
              {planningLabel ?? 'Planning route…'}
            </p>
          ) : phase === 'searching' ? (
            <p className="tc-plan-hit-empty">Searching OpenStreetMap…</p>
          ) : error && suggestions.length === 0 ? (
            <p className="tc-plan-hit-empty">{error}</p>
          ) : suggestions.length === 0 ? (
            <p className="tc-plan-hit-empty">
              {hasRoute
                ? 'Tap Suggest stops'
                : canPlanRoute
                  ? "Tap Suggest stops — we'll plan the route first"
                  : 'Set a destination first'}
            </p>
          ) : (
            suggestions.map((item) => {
              const added = addedIds.has(item.id);
              return (
                <div key={item.id} className="tc-plan-suggest">
                  <div className="tc-plan-suggest-body">
                    <span className="tc-plan-hit-name">{item.place.name}</span>
                    <span className="tc-plan-hit-meta">{item.reason}</span>
                    {item.place.distanceMeters != null ? (
                      <span className="tc-plan-hit-meta">
                        {formatDistanceShort(item.place.distanceMeters)} off
                        route
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="tc-btn tc-btn-ghost"
                    disabled={added}
                    onClick={() => addSuggestion(item)}
                  >
                    {added ? 'Added' : 'Add'}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="tc-sheet-actions tc-sheet-actions-single">
          <button
            type="button"
            className="tc-btn tc-btn-secondary"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
