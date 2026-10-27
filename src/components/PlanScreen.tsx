import { useEffect, useState, type ReactNode } from 'react';
import type { Coordinate } from '../routing/routing-adapter';
import type { CalculatedRoute } from '../routing/routing-adapter';
import type { NavigationState } from '../types/navigation';
import type { PoiKind, StopKind, TripStop } from '../types/trip-stop';
import {
  tripPlanner,
  type TripPlannerState,
} from '../services/trip-planner.service';
import { formatEtaShort } from '../routing/route-naming';
import { getProfile } from '../routing/routing-profiles';
import { StopPickerSheet, type StopPickerMode } from './StopPickerSheet';
import { PoiFinderSheet } from './PoiFinderSheet';
import { StopSuggestSheet } from './StopSuggestSheet';
import { BackgroundIcon } from './NavigationBanner';

interface PlanScreenProps {
  gpsCoordinate: Coordinate | null;
  nav: NavigationState;
  activeRoute: CalculatedRoute | null;
  engineReady: boolean;
  planning: boolean;
  /** The trip was edited after activeRoute was planned. */
  routeOutdated: boolean;
  onPreview: () => void;
  /** Show the planned route on the map, without planning again. */
  onShowMap: () => void;
  /** Set while planning can move to a background notification. */
  onRunInBackground?: () => void;
  /** Plan the itinerary without leaving Plan; throws on routing errors. */
  onPlanInPlace: () => Promise<CalculatedRoute | null>;
  onStart: () => void;
  onClear: () => void;
  onRequestMapPick: (kind: StopKind, mode: 'destination' | 'stop') => void;
}

/** Where the trip is: it decides the summary and the buttons. */
type TripState = 'empty' | 'unplanned' | 'planning' | 'ready' | 'riding' | 'outdated' | 'error';

export function PlanScreen({
  gpsCoordinate,
  nav,
  activeRoute,
  engineReady,
  planning,
  routeOutdated,
  onPreview,
  onShowMap,
  onRunInBackground,
  onPlanInPlace,
  onStart,
  onClear,
  onRequestMapPick,
}: PlanScreenProps) {
  const [itinerary, setItinerary] = useState<TripPlannerState>(
    tripPlanner.getState(),
  );
  const [pickerMode, setPickerMode] = useState<StopPickerMode | null>(null);
  const [suggestKind, setSuggestKind] = useState<PoiKind | null>(null);
  const [browseKind, setBrowseKind] = useState<PoiKind | null>(null);
  /** The stop showing Earlier / Later / Remove. */
  const [openStopId, setOpenStopId] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => tripPlanner.subscribe(setItinerary), []);

  const { destination, stops } = itinerary;
  const canPreview = Boolean(destination) && engineReady;
  const hasRoute =
    Boolean(activeRoute) &&
    !routeOutdated &&
    (nav.status === 'choosing' ||
      nav.status === 'navigating' ||
      nav.status === 'rerouting');
  const state: TripState = !destination
    ? 'empty'
    : planning || nav.status === 'planning'
      ? 'planning'
      : nav.status === 'navigating' || nav.status === 'rerouting'
        ? 'riding'
        : nav.status === 'error'
          ? 'error'
          : routeOutdated
            ? 'outdated'
            : hasRoute
              ? 'ready'
              : 'unplanned';
  const existingStopCoords = [
    ...stops.map((s) => s.coordinate),
    ...(destination ? [destination.coordinate] : []),
  ];

  const handlePickerPick = (stop: TripStop) => {
    if (pickerMode === 'destination') {
      tripPlanner.setDestination(stop);
    } else {
      tripPlanner.addStop(stop, activeRoute?.coordinates ?? null);
    }
    setPickerMode(null);
  };

  const handleStopPick = (stop: TripStop) => {
    tripPlanner.addStop(stop, activeRoute?.coordinates ?? null);
  };

  const openMapPick = (kind: StopKind, mode: 'destination' | 'stop') => {
    setPickerMode(null);
    setSuggestKind(null);
    setBrowseKind(null);
    onRequestMapPick(kind, mode);
  };

  return (
    <main className="tc-main tc-main-plan">
      <header className="tc-plan-hero">
        <p className="tc-downloads-brand">TrailCompass</p>
        <h1 className="tc-section-title">Plan</h1>
        <p className="tc-section-copy">
          Where you're riding, and where to stop on the way.
        </p>
      </header>

      <section className="tc-plan-card" aria-label="Your trip">
        <ol className="tc-plan-timeline">
          <li className="tc-plan-point">
            <div className="tc-plan-point-row">
              <PointIcon kind="start" />
              <span className="tc-plan-point-text">
                <strong>My location</strong>
                <span>{gpsCoordinate ? 'Where you are now' : 'Waiting for GPS…'}</span>
              </span>
            </div>
          </li>

          {stops.map((stop, index) => {
            const open = openStopId === stop.id;
            return (
              <li key={stop.id} className="tc-plan-point">
                <button
                  type="button"
                  className="tc-plan-point-row"
                  aria-expanded={open}
                  onClick={() => setOpenStopId(open ? null : stop.id)}
                >
                  <PointIcon kind={stop.kind} />
                  <span className="tc-plan-point-text">
                    <strong>{stop.name}</strong>
                    <span>{stop.notes || STOP_NOTES[stop.kind]}</span>
                  </span>
                  <span className="tc-plan-point-more" aria-hidden>
                    <MoreIcon />
                  </span>
                </button>
                {open ? (
                  <div className="tc-plan-point-actions">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => tripPlanner.moveStop(stop.id, -1)}
                    >
                      <ArrowIcon up />
                      Earlier
                    </button>
                    <button
                      type="button"
                      disabled={index >= stops.length - 1}
                      onClick={() => tripPlanner.moveStop(stop.id, 1)}
                    >
                      <ArrowIcon />
                      Later
                    </button>
                    <button
                      type="button"
                      className="tc-plan-point-remove"
                      onClick={() => {
                        setOpenStopId(null);
                        tripPlanner.removeStop(stop.id);
                      }}
                    >
                      <TrashIcon />
                      Remove
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}

          <li className="tc-plan-point">
            <button
              type="button"
              className="tc-plan-point-row"
              data-empty={destination ? undefined : 'true'}
              onClick={() => setPickerMode('destination')}
            >
              <PointIcon kind="destination" />
              <span className="tc-plan-point-text">
                <strong>{destination ? destination.name : 'Where to?'}</strong>
                <span>
                  {destination
                    ? destination.notes || 'Destination'
                    : 'Search a place, use GPS or pick it on the map'}
                </span>
              </span>
              <span className="tc-plan-point-action">
                {destination ? 'Change' : <SearchIcon />}
              </span>
            </button>
          </li>
        </ol>
      </section>

      {state === 'empty' ? (
        <ol className="tc-plan-steps" aria-label="How planning works">
          <li>
            <strong>Choose where you're going</strong>
            <span>Search a place, or pick it on the map.</span>
          </li>
          <li>
            <strong>Add stops on the way</strong>
            <span>Fuel by your tank range, food around meal times.</span>
          </li>
          <li>
            <strong>Preview, then ride</strong>
            <span>Check the route on the map and start turn-by-turn.</span>
          </li>
        </ol>
      ) : (
        <section className="tc-plan-add" aria-labelledby="tc-plan-add-heading">
          <h2 className="tc-list-heading" id="tc-plan-add-heading">
            Add a stop
          </h2>
          <div className="tc-plan-add-grid">
            <AddTile kind="fuel" title="Fuel" hint="by tank range" onClick={() => setSuggestKind('fuel')} />
            <AddTile kind="food" title="Food" hint="by meal time" onClick={() => setSuggestKind('food')} />
            <AddTile kind="manual" title="Place" hint="anywhere" onClick={() => setPickerMode('manual')} />
          </div>
          {state !== 'ready' && state !== 'riding' ? (
            <p className="tc-plan-hint">
              Fuel and food are picked along your route, so they're best once
              it's planned.
            </p>
          ) : null}
        </section>
      )}

      {state !== 'empty' ? (
        <TripSummary
          state={state}
          route={activeRoute}
          nav={nav}
          stops={stops.length}
          onRunInBackground={onRunInBackground}
        />
      ) : null}

      {state !== 'empty' ? (
        <div className="tc-plan-actions">
          {state === 'ready' ? (
            <>
              <button type="button" className="tc-plan-primary" onClick={onStart}>
                Start navigation
              </button>
              <button type="button" className="tc-plan-secondary" onClick={onShowMap}>
                Show on map
              </button>
            </>
          ) : state === 'riding' ? (
            <button type="button" className="tc-plan-primary" onClick={onShowMap}>
              Back to the ride
            </button>
          ) : state === 'planning' ? (
            <button type="button" className="tc-plan-secondary" onClick={onShowMap}>
              Watch on map
            </button>
          ) : (
            <button
              type="button"
              className="tc-plan-primary"
              disabled={!canPreview}
              onClick={onPreview}
            >
              {state === 'outdated'
                ? 'Update route'
                : state === 'error'
                  ? 'Try again'
                  : 'Preview on map'}
            </button>
          )}

          {state === 'riding' ? null : confirmingClear ? (
            <div className="tc-plan-confirm" role="group" aria-label="Clear trip">
              <p>Clear the destination and all {stops.length > 0 ? `${stops.length} ` : ''}stops?</p>
              <div className="tc-plan-confirm-actions">
                <button
                  type="button"
                  className="tc-btn tc-btn-secondary"
                  onClick={() => setConfirmingClear(false)}
                >
                  Keep
                </button>
                <button
                  type="button"
                  className="tc-btn tc-btn-danger"
                  onClick={() => {
                    setConfirmingClear(false);
                    setOpenStopId(null);
                    onClear();
                  }}
                >
                  Clear trip
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="tc-plan-clear"
              onClick={() => setConfirmingClear(true)}
            >
              Clear trip
            </button>
          )}
        </div>
      ) : null}

      <StopPickerSheet
        open={pickerMode != null}
        mode={pickerMode ?? 'destination'}
        near={gpsCoordinate}
        gpsCoordinate={gpsCoordinate}
        onClose={() => setPickerMode(null)}
        onPick={handlePickerPick}
        onPickOnMap={() =>
          openMapPick(
            pickerMode === 'destination' ? 'destination' : 'manual',
            pickerMode === 'destination' ? 'destination' : 'stop',
          )
        }
      />

      <StopSuggestSheet
        open={suggestKind != null}
        kind={suggestKind ?? 'fuel'}
        route={activeRoute}
        canPlanRoute={canPreview}
        planningLabel={
          nav.status === 'planning'
            ? (nav.progress?.label ?? nav.message)
            : undefined
        }
        existingCoordinates={existingStopCoords}
        onEnsureRoute={onPlanInPlace}
        onClose={() => setSuggestKind(null)}
        onPick={handleStopPick}
        onBrowse={() => {
          const kind = suggestKind ?? 'fuel';
          setSuggestKind(null);
          setBrowseKind(kind);
        }}
      />

      <PoiFinderSheet
        open={browseKind != null}
        kind={browseKind ?? 'fuel'}
        near={gpsCoordinate}
        route={activeRoute?.coordinates ?? null}
        onClose={() => setBrowseKind(null)}
        onPick={(stop) => {
          handleStopPick(stop);
          setBrowseKind(null);
        }}
      />
    </main>
  );
}

const STOP_NOTES: Record<StopKind, string> = {
  destination: 'Destination',
  fuel: 'Fuel stop',
  food: 'Food stop',
  manual: 'Stop',
};

/** Distance, time and stops; or progress, or what to do next. */
function TripSummary({
  state,
  route,
  nav,
  stops,
  onRunInBackground,
}: {
  state: TripState;
  route: CalculatedRoute | null;
  nav: NavigationState;
  stops: number;
  onRunInBackground?: () => void;
}) {
  const now = useMinuteClock();
  if (state === 'planning') {
    const percent = nav.progress?.percent;
    return (
      <section className="tc-plan-summary" data-state="planning" aria-live="polite">
        <div className="tc-plan-summary-progress">
          <span className="tc-spinner" aria-hidden />
          <span>
            {nav.status === 'planning'
              ? (nav.progress?.label ?? nav.message ?? 'Planning route…')
              : 'Getting GPS…'}
          </span>
        </div>
        {percent != null ? (
          <div className="tc-plan-progress" aria-hidden>
            <div style={{ width: `${Math.round(percent)}%` }} />
          </div>
        ) : null}
        {nav.status === 'planning' && onRunInBackground ? (
          <button
            type="button"
            className="tc-tool-chip tc-plan-background"
            onClick={onRunInBackground}
          >
            <BackgroundIcon />
            Run in background
          </button>
        ) : null}
      </section>
    );
  }

  if ((state === 'ready' || state === 'riding') && route) {
    const riding = state === 'riding';
    const meters = riding ? (nav.remainingDistanceMeters ?? route.distanceMeters) : route.distanceMeters;
    const seconds = riding
      ? (nav.remainingDurationSeconds ?? route.durationSeconds)
      : route.durationSeconds;
    const arrival = new Date(now + seconds * 1000).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    return (
      <section className="tc-plan-summary" data-state={state} aria-live="polite">
        <dl className="tc-plan-stats">
          <div>
            <dt>{riding ? 'To go' : 'Distance'}</dt>
            <dd>{formatKm(meters)}</dd>
          </div>
          <div>
            <dt>Riding</dt>
            <dd>{formatEtaShort(seconds)}</dd>
          </div>
          <div>
            <dt>Stops</dt>
            <dd>{stops}</dd>
          </div>
        </dl>
        <p className="tc-plan-summary-note">
          {riding
            ? `Riding now · arriving around ${arrival}`
            : `${getProfile(nav.profile ?? 'fastest').label} · arrive around ${arrival} if you leave now`}
        </p>
      </section>
    );
  }

  const [tone, text] =
    state === 'error'
      ? (['danger', nav.message ?? "Couldn't plan this trip"] as const)
      : state === 'outdated'
        ? (['accent', 'The trip changed after the route was planned. Update it to see the new distance and time.'] as const)
        : ([undefined, 'Preview the route to see its distance and riding time, and where fuel and food fit.'] as const);
  return (
    <section className="tc-plan-summary" data-state={state} data-tone={tone} aria-live="polite">
      <p className="tc-plan-summary-note">{text}</p>
    </section>
  );
}

/** The time now, updated each minute, for "arrive around". */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function formatKm(meters: number): string {
  const km = meters / 1000;
  if (km >= 10) return `${Math.round(km)} km`;
  if (km >= 1) return `${km.toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

function AddTile({
  kind,
  title,
  hint,
  onClick,
}: {
  kind: 'fuel' | 'food' | 'manual';
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="tc-plan-add-btn" onClick={onClick}>
      <PointIcon kind={kind} />
      <strong>{title}</strong>
      <span>{hint}</span>
    </button>
  );
}

const POINT_ICONS: Record<StopKind | 'start', ReactNode> = {
  start: (
    <>
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
      <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="2" />
    </>
  ),
  fuel: (
    <path
      d="M5 20V6a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v14M4 20h11M8 9h3M14 11h1.5a1.5 1.5 0 0 1 1.5 1.5v3a1.2 1.2 0 0 0 2.4 0V8.5L17 6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  food: (
    <path
      d="M7.5 3v7M5 3v4.5a2.5 2.5 0 0 0 5 0V3M7.5 10v11M16.5 21V3c-1.9 1-3 3.1-3 6v3h3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  manual: (
    <>
      <path
        d="M12 21s-6-5-6-10.2a6 6 0 0 1 12 0C18 16 12 21 12 21Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10.5" r="2" fill="currentColor" />
    </>
  ),
  destination: (
    <path
      d="M6 21V4M6 4h10.5l-2 4 2 4H6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
};

function PointIcon({ kind }: { kind: StopKind | 'start' }) {
  return (
    <span className="tc-plan-icon" data-kind={kind} aria-hidden>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
        {POINT_ICONS[kind]}
      </svg>
    </span>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
      <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon({ up = false }: { up?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
      <path
        d={up ? 'M12 19V5m0 0-6 6m6-6 6 6' : 'M12 5v14m0 0-6-6m6 6 6-6'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
      <path
        d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
