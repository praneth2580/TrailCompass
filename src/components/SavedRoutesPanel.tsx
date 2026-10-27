import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type { Coordinate, SavedRoute } from '../types/route';
import { routeLibrary } from '../services/route-library.service';
import { formatEtaShort, formatSavedAt } from '../routing/route-naming';
import { getProfile } from '../routing/routing-profiles';

interface SavedRoutesPanelProps {
  onOpenRoute: (route: SavedRoute) => void;
  /** From the empty library, go and plan a trip. */
  onPlanTrip?: () => void;
  refreshKey?: number;
}

/** A search box appears once there are this many trips. */
const SEARCH_FROM = 6;

interface Notice {
  text: string;
  tone: 'ok' | 'err';
  /** A deleted trip that Undo can put back. */
  undo?: SavedRoute;
}

export function SavedRoutesPanel({
  onOpenRoute,
  onPlanTrip,
  refreshKey = 0,
}: SavedRoutesPanelProps) {
  const [routes, setRoutes] = useState<SavedRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState<{ id: string; action: 'share' | 'delete' } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    const list = await routeLibrary.list();
    setRoutes(list);
  }, []);

  useEffect(() => {
    let alive = true;
    void routeLibrary.list().then((list) => {
      if (!alive) return;
      setRoutes(list);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  const handleImportClick = () => fileRef.current?.click();

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImporting(true);
    setNotice(null);
    try {
      const saved = await routeLibrary.importFromFile(file);
      await reload();
      setNotice({ text: `Imported “${saved.name}”`, tone: 'ok' });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : 'Import failed', tone: 'err' });
    } finally {
      setImporting(false);
    }
  };

  const handleShare = async (route: SavedRoute) => {
    setBusy({ id: route.id, action: 'share' });
    setNotice(null);
    try {
      const shared = await routeLibrary.exportAndShare(route, 'trailcompass');
      if (!shared) return;
      setNotice({
        text: Capacitor.isNativePlatform()
          ? `Sharing “${route.name}”`
          : `Downloaded “${route.name}”`,
        tone: 'ok',
      });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : 'Share failed', tone: 'err' });
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (route: SavedRoute) => {
    setBusy({ id: route.id, action: 'delete' });
    setNotice(null);
    try {
      await routeLibrary.delete(route.id);
      await reload();
      setNotice({ text: `Deleted “${route.name}”`, tone: 'ok', undo: route });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : 'Delete failed', tone: 'err' });
    } finally {
      setBusy(null);
    }
  };

  const handleUndo = async (route: SavedRoute) => {
    setNotice(null);
    try {
      await routeLibrary.restore(route);
      await reload();
      setNotice({ text: `Restored “${route.name}”`, tone: 'ok' });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : 'Undo failed', tone: 'err' });
    }
  };

  const anyBusy = importing || busy != null;
  const search = query.trim().toLowerCase();
  const shown = search
    ? routes.filter((route) => route.name.toLowerCase().includes(search))
    : routes;

  return (
    <section className="tc-library" aria-labelledby="tc-trips-heading">
      <div className="tc-library-head">
        <h2 className="tc-list-heading" id="tc-trips-heading">
          Saved trips
          {routes.length > 0 ? <span className="tc-library-count"> · {routes.length}</span> : null}
        </h2>
        {routes.length > 0 || importing ? (
          <button
            type="button"
            className="tc-library-import"
            onClick={handleImportClick}
            disabled={anyBusy}
          >
            {importing ? (
              <span className="tc-spinner tc-spinner-sm" aria-hidden />
            ) : (
              <ImportIcon />
            )}
            {importing ? 'Importing…' : 'Import'}
          </button>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept=".json,.geojson,application/json,.trailcompass.json"
          className="tc-file-input"
          onChange={(e) => void handleFileChange(e)}
        />
      </div>

      {routes.length >= SEARCH_FROM ? (
        <label className="tc-library-search">
          <SearchIcon />
          <span className="tc-visually-hidden">Search saved trips</span>
          <input
            type="search"
            placeholder="Search trips"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      ) : null}

      {notice ? (
        <div className="tc-library-notice" data-tone={notice.tone} role="status">
          <span>{notice.text}</span>
          {notice.undo ? (
            <button type="button" onClick={() => void handleUndo(notice.undo!)}>
              Undo
            </button>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="tc-saved-loading" role="status">
          <span className="tc-spinner" aria-hidden />
          <span>Loading saved trips…</span>
        </div>
      ) : routes.length === 0 ? (
        <div className="tc-library-empty">
          <span className="tc-library-empty-icon" aria-hidden>
            <SavedTripIcon />
          </span>
          <strong>No saved trips yet</strong>
          <p>
            Plan a route, then tap Save on the map. A saved trip opens again
            here with its stops and turn-by-turn, without planning.
          </p>
          <div className="tc-library-empty-actions">
            {onPlanTrip ? (
              <button type="button" className="tc-btn" onClick={onPlanTrip}>
                Plan a trip
              </button>
            ) : null}
            <button
              type="button"
              className="tc-btn tc-btn-secondary"
              onClick={handleImportClick}
              disabled={importing}
            >
              {importing ? 'Importing…' : 'Import a file'}
            </button>
          </div>
        </div>
      ) : shown.length === 0 ? (
        <p className="tc-library-hint">No trips match “{query.trim()}”.</p>
      ) : (
        <ul className="tc-library-list">
          {shown.map((route) => (
            <li key={route.id} className="tc-trip">
              <button
                type="button"
                className="tc-trip-open"
                onClick={() => onOpenRoute(route)}
                disabled={anyBusy}
              >
                <RouteThumbnail route={route} />
                <span className="tc-trip-text">
                  <strong>{route.name}</strong>
                  <span className="tc-trip-facts">{tripFacts(route)}</span>
                  <span className="tc-trip-meta">{tripMeta(route)}</span>
                </span>
              </button>
              <div className="tc-trip-actions">
                <button
                  type="button"
                  className="tc-trip-icon"
                  aria-label={`Share ${route.name}`}
                  onClick={() => void handleShare(route)}
                  disabled={anyBusy}
                >
                  {busy?.id === route.id && busy.action === 'share' ? (
                    <span className="tc-spinner tc-spinner-sm" aria-hidden />
                  ) : (
                    <ShareIcon />
                  )}
                </button>
                <button
                  type="button"
                  className="tc-trip-icon tc-trip-icon-danger"
                  aria-label={`Delete ${route.name}`}
                  onClick={() => void handleDelete(route)}
                  disabled={anyBusy}
                >
                  {busy?.id === route.id && busy.action === 'delete' ? (
                    <span className="tc-spinner tc-spinner-sm" aria-hidden />
                  ) : (
                    <TrashIcon />
                  )}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {routes.length > 0 ? (
        <p className="tc-library-hint">
          Tap a trip to open it on the map. Share sends it as a file; Import
          opens one shared with you, or a GeoJSON route.
        </p>
      ) : null}
    </section>
  );
}

/** "331 km · 7h 25m · 2 stops" */
function tripFacts(route: SavedRoute): string {
  const km = route.distanceMeters / 1000;
  const parts = [
    km >= 10 ? `${Math.round(km)} km` : km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(route.distanceMeters)} m`,
    formatEtaShort(route.durationSeconds),
  ];
  const stops = route.waypoints?.length ?? 0;
  if (stops > 0) parts.push(`${stops} stop${stops === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** "Less traffic · saved 3 days ago" */
function tripMeta(route: SavedRoute): string {
  const saved = `saved ${formatSavedAt(route.updatedAt)}`;
  return route.profile ? `${getProfile(route.profile).label} · ${saved}` : saved;
}

const THUMB_SIZE = 64;
const THUMB_PAD = 10;
/** Enough points for the shape; long routes have thousands. */
const THUMB_POINTS = 80;

/** The route's shape, north up, with its start, stops and end. */
function RouteThumbnail({ route }: { route: SavedRoute }) {
  const shape = useMemo(() => thumbnailShape(route), [route]);
  return (
    <svg className="tc-trip-thumb" viewBox={`0 0 ${THUMB_SIZE} ${THUMB_SIZE}`} aria-hidden>
      <polyline className="tc-trip-thumb-casing" points={shape.line} />
      <polyline className="tc-trip-thumb-line" points={shape.line} />
      {shape.stops.map(([x, y], i) => (
        <circle key={i} className="tc-trip-thumb-stop" cx={x} cy={y} r={2.6} />
      ))}
      <circle className="tc-trip-thumb-end" cx={shape.end[0]} cy={shape.end[1]} r={3.8} />
      {/* On top, so a loop shows its start inside the end ring. */}
      <circle className="tc-trip-thumb-start" cx={shape.start[0]} cy={shape.start[1]} r={3} />
    </svg>
  );
}

function thumbnailShape(route: SavedRoute) {
  const coords = route.coordinates.length >= 2 ? route.coordinates : [route.start, route.end];
  // Shrink longitude by latitude, so the shape keeps its proportions.
  const midLat = (coords[0]![1] + coords[coords.length - 1]![1]) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [lon, lat] of coords) {
    minX = Math.min(minX, lon * kx);
    maxX = Math.max(maxX, lon * kx);
    minY = Math.min(minY, lat);
    maxY = Math.max(maxY, lat);
  }
  const scale = (THUMB_SIZE - 2 * THUMB_PAD) / Math.max(maxX - minX, maxY - minY, 1e-6);
  const offsetX = (THUMB_SIZE - (maxX - minX) * scale) / 2;
  const offsetY = (THUMB_SIZE - (maxY - minY) * scale) / 2;
  const project = ([lon, lat]: Coordinate): [number, number] => [
    Math.round((offsetX + (lon * kx - minX) * scale) * 10) / 10,
    Math.round((offsetY + (maxY - lat) * scale) * 10) / 10,
  ];
  const step = Math.max(1, Math.floor(coords.length / THUMB_POINTS));
  const line = coords
    .filter((_, i) => i % step === 0 || i === coords.length - 1)
    .map((point) => project(point).join(','))
    .join(' ');
  return {
    line,
    start: project(coords[0]!),
    end: project(coords[coords.length - 1]!),
    stops: (route.waypoints ?? []).map(project),
  };
}

function ImportIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
      <path
        d="M12 15V4m0 11-4-4m4 4 4-4M5 20h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
      <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden>
      <circle cx="18" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="6" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="19" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8.3 10.7 15.7 6.3M8.3 13.3l7.4 4.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden>
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

function SavedTripIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden>
      <path
        d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M9 12.5c1.5-3 4.5-1 6-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
