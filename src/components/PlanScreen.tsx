import { useEffect, useState } from 'react';
import type { Coordinate } from '../routing/routing-adapter';
import type { CalculatedRoute } from '../routing/routing-adapter';
import type { NavigationState } from '../types/navigation';
import {
  formatCoordShort,
  stopKindLabel,
  type PoiKind,
  type StopKind,
  type TripStop,
} from '../types/trip-stop';
import {
  tripPlanner,
  type TripPlannerState,
} from '../services/trip-planner.service';
import { formatDistanceShort, formatEtaShort } from '../routing/route-naming';
import { StopPickerSheet, type StopPickerMode } from './StopPickerSheet';
import { PoiFinderSheet } from './PoiFinderSheet';
import { StopSuggestSheet } from './StopSuggestSheet';

interface PlanScreenProps {
  gpsCoordinate: Coordinate | null;
  nav: NavigationState;
  activeRoute: CalculatedRoute | null;
  engineReady: boolean;
  planning: boolean;
  onPreview: () => void;
  onStart: () => void;
  onClear: () => void;
  onRequestMapPick: (kind: StopKind, mode: 'destination' | 'stop') => void;
}

export function PlanScreen({
  gpsCoordinate,
  nav,
  activeRoute,
  engineReady,
  planning,
  onPreview,
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

  useEffect(() => tripPlanner.subscribe(setItinerary), []);

  const { destination, stops } = itinerary;
  const canPreview = Boolean(destination) && engineReady;
  const hasRoute =
    Boolean(activeRoute) &&
    (nav.status === 'choosing' ||
      nav.status === 'navigating' ||
      nav.status === 'rerouting');
  const summaryRoute = activeRoute;
  const existingStopCoords = [
    ...stops.map((s) => s.coordinate),
    ...(destination ? [destination.coordinate] : []),
  ];

  const handlePickerPick = (stop: TripStop) => {
    if (pickerMode === 'destination') {
      tripPlanner.setDestination(stop);
    } else {
      tripPlanner.addStop(stop);
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
          Build your trip as a list — fuel by tank range, food by time of day —
          then preview on the map.
        </p>
      </header>

      <section className="tc-plan-card" aria-label="Itinerary">
        <div className="tc-plan-row tc-plan-row-fixed">
          <span className="tc-plan-badge tc-plan-badge-start" aria-hidden>
            A
          </span>
          <div className="tc-plan-row-body">
            <strong>My location</strong>
            <span>
              {gpsCoordinate
                ? formatCoordShort(gpsCoordinate)
                : 'Waiting for GPS…'}
            </span>
          </div>
        </div>

        {stops.map((stop, index) => (
          <StopRow
            key={stop.id}
            stop={stop}
            index={index}
            total={stops.length}
            onMove={(dir) => tripPlanner.moveStop(stop.id, dir)}
            onRemove={() => tripPlanner.removeStop(stop.id)}
          />
        ))}

        <button
          type="button"
          className="tc-plan-row tc-plan-row-dest"
          onClick={() => setPickerMode('destination')}
        >
          <span className="tc-plan-badge tc-plan-badge-end" aria-hidden>
            B
          </span>
          <div className="tc-plan-row-body">
            <strong>
              {destination ? destination.name : 'Set destination'}
            </strong>
            <span>
              {destination
                ? formatCoordShort(destination.coordinate)
                : 'Search, GPS, or pick on map'}
            </span>
          </div>
          <span className="tc-plan-row-action">
            {destination ? 'Edit' : 'Add'}
          </span>
        </button>
      </section>

      <section className="tc-plan-add" aria-label="Add stops">
        <p className="tc-list-heading">Along the way</p>
        <div className="tc-plan-add-grid">
          <button
            type="button"
            className="tc-plan-add-btn"
            disabled={!destination && !gpsCoordinate}
            onClick={() => setSuggestKind('fuel')}
          >
            <span className="tc-plan-add-glyph tc-plan-add-fuel">F</span>
            Fuel
          </button>
          <button
            type="button"
            className="tc-plan-add-btn"
            disabled={!destination && !gpsCoordinate}
            onClick={() => setSuggestKind('food')}
          >
            <span className="tc-plan-add-glyph tc-plan-add-food">E</span>
            Food
          </button>
          <button
            type="button"
            className="tc-plan-add-btn"
            onClick={() => setPickerMode('manual')}
          >
            <span className="tc-plan-add-glyph tc-plan-add-manual">+</span>
            Custom
          </button>
        </div>
        {!hasRoute ? (
          <p className="tc-plan-hint">
            Tip: Preview on map first for smarter fuel/food suggestions along
            the route.
          </p>
        ) : null}
      </section>

      <section className="tc-plan-summary" aria-live="polite">
        {planning || nav.status === 'planning' ? (
          <p className="tc-plan-summary-line">
            {nav.status === 'planning'
              ? (nav.progress?.label ?? nav.message ?? 'Planning route…')
              : 'Getting GPS…'}
          </p>
        ) : summaryRoute ? (
          <p className="tc-plan-summary-line">
            <strong>{formatDistanceShort(summaryRoute.distanceMeters)}</strong>
            <span aria-hidden> · </span>
            <strong>{formatEtaShort(summaryRoute.durationSeconds)}</strong>
            {stops.length > 0 ? (
              <>
                <span aria-hidden> · </span>
                <span>
                  {stops.length} stop{stops.length === 1 ? '' : 's'}
                </span>
              </>
            ) : null}
          </p>
        ) : destination ? (
          <p className="tc-plan-summary-line">
            Ready to preview — roads load when you plan
          </p>
        ) : (
          <p className="tc-plan-summary-line">Add a destination to begin</p>
        )}
        {nav.status === 'error' && nav.message ? (
          <p className="tc-plan-summary-error">{nav.message}</p>
        ) : null}
      </section>

      <div className="tc-plan-actions">
        <button
          type="button"
          className="tc-plan-primary"
          disabled={!canPreview}
          onClick={onPreview}
        >
          {planning || nav.status === 'planning'
            ? 'Preview again'
            : 'Preview on map'}
        </button>
        <button
          type="button"
          className="tc-plan-secondary"
          disabled={!hasRoute || planning}
          onClick={onStart}
        >
          Start navigation
        </button>
        {(destination || stops.length > 0) && (
          <button
            type="button"
            className="tc-plan-clear"
            onClick={onClear}
          >
            Clear trip
          </button>
        )}
      </div>

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
        existingCoordinates={existingStopCoords}
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

function StopRow({
  stop,
  index,
  total,
  onMove,
  onRemove,
}: {
  stop: TripStop;
  index: number;
  total: number;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="tc-plan-row">
      <span
        className={`tc-plan-badge tc-plan-badge-${stop.kind}`}
        aria-hidden
      >
        {stop.kind === 'fuel' ? 'F' : stop.kind === 'food' ? 'E' : '+'}
      </span>
      <div className="tc-plan-row-body">
        <strong>{stop.name}</strong>
        <span>
          {stop.notes
            ? stop.notes
            : `${stopKindLabel(stop.kind)} · ${formatCoordShort(stop.coordinate)}`}
        </span>
      </div>
      <div className="tc-plan-row-controls">
        <button
          type="button"
          className="tc-plan-icon-btn"
          aria-label="Move up"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="tc-plan-icon-btn"
          aria-label="Move down"
          disabled={index >= total - 1}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="tc-plan-icon-btn tc-plan-icon-danger"
          aria-label={`Remove ${stop.name}`}
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
