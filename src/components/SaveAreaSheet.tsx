import { useId, useMemo, useRef, useState } from 'react';
import { MAX_TILES, planAreaTiles } from '../offline/tile-plan';
import { areaPackId, mapDetail, mapPackService } from '../services/map-pack.service';
import { searchAreas, type AreaHit } from '../services/place-search.service';
import { useBackHandler } from '../hooks/useBackHandler';

interface SaveAreaSheetProps {
  open: boolean;
  onClose: () => void;
  /** The area's download has started (it runs in the background). */
  onSaving: (name: string) => void;
}

/** Search a city, district or state, then save its map. */
export function SaveAreaSheet({ open, onClose, onSaving }: SaveAreaSheetProps) {
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<AreaHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<AreaHit | null>(null);
  const searchId = useRef(0);

  const plan = useMemo(() => (picked ? planAreaTiles(picked.shape, MAX_TILES) : null), [picked]);
  const alreadySaved = useMemo(() => (plan ? mapPackService.savedCount(plan.tiles) : 0), [plan]);

  const close = () => {
    searchId.current += 1;
    setQuery('');
    setHits([]);
    setError(null);
    setBusy(false);
    setPicked(null);
    onClose();
  };

  useBackHandler(open, () => (picked ? setPicked(null) : close()));

  if (!open) return null;

  const runSearch = () => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setError('Type at least 2 letters');
      return;
    }
    const id = ++searchId.current;
    setBusy(true);
    setError(null);
    void searchAreas(trimmed)
      .then((results) => {
        if (id !== searchId.current) return;
        setHits(results);
        setError(results.length === 0 ? 'No areas found' : null);
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

  const save = () => {
    if (!picked) return;
    void mapPackService
      .downloadArea({ key: picked.key, name: picked.name, shape: picked.shape })
      .catch(() => undefined);
    onSaving(picked.name);
    close();
  };

  const existing = picked ? mapPackService.get(areaPackId(picked.key)) : undefined;

  return (
    <div className="tc-sheet-root" role="presentation">
      <button type="button" className="tc-sheet-backdrop" aria-label="Close" onClick={close} />
      <div className="tc-sheet tc-sheet-tall" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="tc-sheet-handle" aria-hidden />
        <header className="tc-sheet-header">
          <h2 id={titleId} className="tc-sheet-title">
            Save an area
          </h2>
          <p className="tc-sheet-hint">
            A city, district or state, kept on this phone so its map shows
            without signal.
          </p>
        </header>

        {picked && plan ? (
          <div className="tc-area-plan">
            <strong>{picked.name}</strong>
            <span>
              {picked.kind} · {truncate(picked.subtitle, 64)}
            </span>
            <ul className="tc-area-plan-facts">
              <li>
                <b>{mapDetail(plan.maxZoom)}</b> · {plan.tiles.length.toLocaleString()} tiles
              </li>
              {alreadySaved > 0 ? (
                <li>
                  {alreadySaved.toLocaleString()} of them already on this phone, so they
                  aren't downloaded again
                </li>
              ) : null}
              {existing?.downloadedAt ? (
                <li>Saved before; this brings it up to date</li>
              ) : null}
            </ul>
            {plan.maxZoom < 14 ? (
              <p className="tc-area-plan-note">
                Too big for full street detail: OpenFreeMap allows{' '}
                {MAX_TILES.toLocaleString()} tiles per download. Save a city
                inside it for its streets.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <form
              className="tc-plan-search-form"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                runSearch();
              }}
            >
              <label className="tc-plan-search">
                <span className="tc-visually-hidden">Search areas</span>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Mumbai, Pune, Maharashtra…"
                  autoComplete="off"
                  enterKeyHint="search"
                  autoFocus
                />
              </label>
              <button type="submit" className="tc-btn" disabled={busy}>
                Search
              </button>
            </form>

            <div className="tc-plan-hit-list" role="listbox" aria-label="Areas">
              {busy ? (
                <p className="tc-plan-hit-empty">Searching…</p>
              ) : error && hits.length === 0 ? (
                <p className="tc-plan-hit-empty">{error}</p>
              ) : hits.length === 0 ? (
                <p className="tc-plan-hit-empty">Type an area, then tap Search</p>
              ) : (
                hits.map((hit) => (
                  <button
                    key={hit.key}
                    type="button"
                    className="tc-plan-hit"
                    role="option"
                    aria-selected={false}
                    onClick={() => setPicked(hit)}
                  >
                    <span className="tc-plan-hit-name">{hit.name}</span>
                    <span className="tc-plan-hit-meta">
                      {hit.kind} · {truncate(hit.subtitle, 48)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </>
        )}

        <div className={picked ? 'tc-sheet-actions' : 'tc-sheet-actions tc-sheet-actions-single'}>
          <button
            type="button"
            className="tc-btn tc-btn-secondary"
            onClick={() => (picked ? setPicked(null) : close())}
          >
            {picked ? 'Back' : 'Cancel'}
          </button>
          {picked ? (
            <button type="button" className="tc-btn" onClick={save}>
              {existing ? 'Update area' : 'Save area'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
