import { useEffect, useId, useState } from 'react';
import type { Coordinate } from '../routing/routing-adapter';
import { findPois } from '../services/poi-search.service';
import { formatDistanceShort } from '../routing/route-naming';
import {
  createTripStop,
  formatCoordShort,
  type PlaceHit,
  type PoiKind,
  type TripStop,
} from '../types/trip-stop';

type Scope = 'along' | 'near';

interface PoiFinderSheetProps {
  open: boolean;
  kind: PoiKind;
  near?: Coordinate | null;
  route?: Coordinate[] | null;
  onClose: () => void;
  onPick: (stop: TripStop) => void;
}

export function PoiFinderSheet({
  open,
  kind,
  near,
  route,
  onClose,
  onPick,
}: PoiFinderSheetProps) {
  const titleId = useId();
  const canAlong = Boolean(route && route.length >= 2);
  const defaultScope: Scope = canAlong ? 'along' : 'near';
  const sessionKey = open ? `${kind}:${defaultScope}` : '';
  const [session, setSession] = useState(sessionKey);
  const [scope, setScope] = useState<Scope>(defaultScope);
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sessionKey !== session) {
    setSession(sessionKey);
    setScope(defaultScope);
    setHits([]);
    setBusy(false);
    setError(null);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void (async () => {
      // Defer busy flag so the effect itself stays free of sync setState.
      await Promise.resolve();
      if (cancelled) return;
      setBusy(true);
      setError(null);
      setHits([]);
      try {
        const results = await findPois({
          kind,
          near: scope === 'near' ? near : null,
          route: scope === 'along' ? route : null,
          radiusMeters: scope === 'along' ? 2_000 : 3_500,
          limit: 24,
        });
        if (cancelled) return;
        setHits(results);
        setError(
          results.length === 0
            ? scope === 'along'
              ? 'No matches along this route — try Near me'
              : 'No matches nearby'
            : null,
        );
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Search failed');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, kind, scope, near, route]);

  if (!open) return null;

  const title = kind === 'fuel' ? 'Add fuel stop' : 'Add food stop';
  const hint =
    kind === 'fuel'
      ? 'Pick a station from the list — no map hunting.'
      : 'Pick a place to eat from the list.';

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

        <div className="tc-plan-scope" role="tablist" aria-label="Search area">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'along'}
            className={
              scope === 'along'
                ? 'tc-plan-scope-btn tc-plan-scope-btn-active'
                : 'tc-plan-scope-btn'
            }
            disabled={!canAlong}
            onClick={() => {
              setScope('along');
              setBusy(true);
              setError(null);
            }}
          >
            Along trip
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'near'}
            className={
              scope === 'near'
                ? 'tc-plan-scope-btn tc-plan-scope-btn-active'
                : 'tc-plan-scope-btn'
            }
            disabled={!near}
            onClick={() => {
              setScope('near');
              setBusy(true);
              setError(null);
            }}
          >
            Near me
          </button>
        </div>

        <div className="tc-plan-hit-list" role="listbox" aria-label="Places">
          {busy ? (
            <p className="tc-plan-hit-empty">Looking up OpenStreetMap…</p>
          ) : error && hits.length === 0 ? (
            <p className="tc-plan-hit-empty">{error}</p>
          ) : (
            hits.map((hit) => (
              <button
                key={hit.id}
                type="button"
                className="tc-plan-hit"
                role="option"
                onClick={() =>
                  onPick(createTripStop(kind, hit.coordinate, hit.name))
                }
              >
                <span className="tc-plan-hit-name">{hit.name}</span>
                <span className="tc-plan-hit-meta">
                  {hit.distanceMeters != null
                    ? scope === 'along'
                      ? `${formatDistanceShort(hit.distanceMeters)} off route`
                      : formatDistanceShort(hit.distanceMeters)
                    : formatCoordShort(hit.coordinate)}
                  {hit.subtitle ? ` · ${hit.subtitle}` : ''}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="tc-sheet-actions tc-sheet-actions-single">
          <button
            type="button"
            className="tc-btn tc-btn-secondary"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
