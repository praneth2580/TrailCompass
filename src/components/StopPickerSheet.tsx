import { useId, useRef, useState } from 'react';
import type { Coordinate } from '../routing/routing-adapter';
import { searchPlaces } from '../services/place-search.service';
import {
  createTripStop,
  formatCoordShort,
  type PlaceHit,
  type StopKind,
  type TripStop,
} from '../types/trip-stop';
import { formatDistanceShort } from '../routing/route-naming';

export type StopPickerMode = 'destination' | 'manual';

interface StopPickerSheetProps {
  open: boolean;
  mode: StopPickerMode;
  near?: Coordinate | null;
  gpsCoordinate?: Coordinate | null;
  onClose: () => void;
  onPick: (stop: TripStop) => void;
  onPickOnMap: () => void;
}

export function StopPickerSheet({
  open,
  mode,
  near,
  gpsCoordinate,
  onClose,
  onPick,
  onPickOnMap,
}: StopPickerSheetProps) {
  const titleId = useId();
  const sessionKey = open ? `${mode}` : '';
  const [session, setSession] = useState(sessionKey);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped per search and on close, so a late reply cannot land in a newer session. */
  const searchId = useRef(0);

  if (sessionKey !== session) {
    setSession(sessionKey);
    setQuery('');
    setHits([]);
    setBusy(false);
    setError(null);
  }

  if (!open) return null;

  // Search only on submit: Nominatim's usage policy forbids search-as-you-type.
  const runSearch = () => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setHits([]);
      setError('Type at least 2 letters');
      return;
    }
    const id = ++searchId.current;
    setBusy(true);
    setError(null);
    void searchPlaces(trimmed, near ?? gpsCoordinate)
      .then((results) => {
        if (id !== searchId.current) return;
        setHits(results);
        setError(results.length === 0 ? 'No places found' : null);
      })
      .catch((e) => {
        if (id !== searchId.current) return;
        setHits([]);
        setError(e instanceof Error ? e.message : 'Search failed');
      })
      .finally(() => {
        if (id === searchId.current) setBusy(false);
      });
  };

  const close = () => {
    searchId.current += 1;
    onClose();
  };

  const kind: StopKind = mode === 'destination' ? 'destination' : 'manual';
  const title = mode === 'destination' ? 'Where to?' : 'Add custom stop';
  const hint =
    mode === 'destination'
      ? 'Search a place, use GPS, or pick once on the map.'
      : 'Search, use your location, or tap the map once.';

  const selectHit = (hit: PlaceHit) => {
    onPick(createTripStop(kind, hit.coordinate, hit.name));
  };

  const useGps = () => {
    if (!gpsCoordinate) return;
    onPick(
      createTripStop(
        kind,
        gpsCoordinate,
        mode === 'destination' ? 'My location' : 'Current location',
      ),
    );
  };

  const showEmptyHint = hits.length === 0 && !busy && !error;

  return (
    <div className="tc-sheet-root" role="presentation">
      <button
        type="button"
        className="tc-sheet-backdrop"
        aria-label="Close"
        onClick={close}
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

        <form
          className="tc-plan-search-form"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
        >
          <label className="tc-plan-search">
            <span className="tc-visually-hidden">Search places</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search places…"
              autoComplete="off"
              enterKeyHint="search"
              autoFocus
            />
          </label>
          <button type="submit" className="tc-btn" disabled={busy}>
            Search
          </button>
        </form>

        <div className="tc-plan-quick-actions">
          <button
            type="button"
            className="tc-plan-quick-btn"
            disabled={!gpsCoordinate}
            onClick={useGps}
          >
            Use my location
          </button>
          <button
            type="button"
            className="tc-plan-quick-btn"
            onClick={onPickOnMap}
          >
            Pick on map
          </button>
        </div>

        <div className="tc-plan-hit-list" role="listbox" aria-label="Places">
          {busy ? (
            <p className="tc-plan-hit-empty">Searching…</p>
          ) : error && hits.length === 0 ? (
            <p className="tc-plan-hit-empty">{error}</p>
          ) : showEmptyHint ? (
            <p className="tc-plan-hit-empty">
              Type a place, then tap Search
            </p>
          ) : (
            hits.map((hit) => (
              <button
                key={hit.id}
                type="button"
                className="tc-plan-hit"
                role="option"
                onClick={() => selectHit(hit)}
              >
                <span className="tc-plan-hit-name">{hit.name}</span>
                <span className="tc-plan-hit-meta">
                  {hit.distanceMeters != null
                    ? formatDistanceShort(hit.distanceMeters)
                    : formatCoordShort(hit.coordinate)}
                  {hit.subtitle ? ` · ${truncate(hit.subtitle, 48)}` : ''}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="tc-sheet-actions tc-sheet-actions-single">
          <button
            type="button"
            className="tc-btn tc-btn-secondary"
            onClick={close}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
