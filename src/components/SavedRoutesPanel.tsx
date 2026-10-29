import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type { SavedRoute } from '../types/route';
import { importSummary, routeLibrary } from '../services/route-library.service';
import {
  mapPackService,
  routePackId,
  type MapPackJob,
  type MapPackMeta,
} from '../services/map-pack.service';
import { formatEtaShort, formatSavedAt } from '../routing/route-naming';
import { getProfile } from '../routing/routing-profiles';
import { TrackThumbnail } from './TrackThumbnail';

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
  const [importProgress, setImportProgress] = useState<number | null>(null);
  // Re-render when a map download moves on or finishes.
  const [, setMapTick] = useState(0);
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

  useEffect(() => {
    let alive = true;
    void mapPackService.init().then(() => {
      if (alive) setMapTick((n) => n + 1);
    });
    const off = mapPackService.subscribe(() => setMapTick((n) => n + 1));
    return () => {
      alive = false;
      off();
    };
  }, []);

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
      const outcome = await routeLibrary.importFromFile(file, (done, total) =>
        setImportProgress(total > 0 ? Math.round((done / total) * 100) : null),
      );
      await reload();
      setNotice({ text: importSummary(outcome), tone: 'ok' });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : 'Import failed', tone: 'err' });
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };

  const handleShare = async (route: SavedRoute) => {
    setBusy({ id: route.id, action: 'share' });
    setNotice(null);
    try {
      // With its offline map when it has one.
      const shared = await routeLibrary.exportAndShare(route, 'trailcompass', { withMap: true });
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
            {importing
              ? importProgress != null
                ? `Importing ${importProgress}%`
                : 'Importing…'
              : 'Import'}
          </button>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          // Android only lists types it knows: shared maps arrive as octet-stream.
          accept=".json,.geojson,application/json,.trailcompass.json,.pmtiles,application/octet-stream"
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
                <TrackThumbnail
                  coordinates={route.coordinates.length >= 2 ? route.coordinates : [route.start, route.end]}
                  stops={route.waypoints ?? []}
                />
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
              <TripMapRow
                pack={mapPackService.packForRoute(route.id)}
                job={mapPackService.getJob(routePackId(route.id))}
                disabled={anyBusy}
                onDownload={() => void mapPackService.downloadRoute(route).catch(() => undefined)}
                onCancel={() => mapPackService.cancel(routePackId(route.id))}
              />
            </li>
          ))}
        </ul>
      )}

      {routes.length > 0 ? (
        <p className="tc-library-hint">
          Tap a trip to open it on the map. Share sends it as a file, with its
          offline map when it has one; Import opens one shared with you, or a
          GeoJSON route.
        </p>
      ) : null}
    </section>
  );
}

/** Whether the trip's map is on the phone, with a button to save or stop it. */
function TripMapRow({
  pack,
  job,
  disabled,
  onDownload,
  onCancel,
}: {
  pack: MapPackMeta | undefined;
  job: MapPackJob | undefined;
  disabled: boolean;
  onDownload: () => void;
  onCancel: () => void;
}) {
  let text: string;
  let tone: 'ok' | 'err' | undefined;
  let action: { label: string; run: () => void } | null = null;
  let percent: number | null = null;

  if (job?.state === 'downloading') {
    percent = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
    text = job.retrying
      ? `Saving map · ${percent}% · trying ${job.retrying} tile${job.retrying === 1 ? '' : 's'} again`
      : `Saving map · ${percent}%`;
    action = { label: 'Stop', run: onCancel };
  } else if (job?.state === 'queued') {
    text = 'Map waiting for another download';
    action = { label: 'Stop', run: onCancel };
  } else if (job?.state === 'waiting-wifi') {
    text = 'Map waits for Wi-Fi';
    action = { label: 'Stop', run: onCancel };
  } else if (job?.state === 'error') {
    text = job.message;
    tone = 'err';
    action = { label: 'Retry', run: onDownload };
  } else if (pack && pack.saved < pack.tiles) {
    text = `Map ${Math.floor((pack.saved / Math.max(1, pack.tiles)) * 100)}% saved`;
    action = { label: 'Resume', run: onDownload };
  } else if (pack) {
    text = [
      `Offline map · ${formatBytes(pack.bytes)}`,
      pack.maxZoom < 14 ? 'less street detail' : null,
      pack.downloadedAt ? `downloaded ${formatSavedAt(pack.downloadedAt)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    tone = 'ok';
  } else {
    text = 'No offline map yet';
    action = { label: 'Save map', run: onDownload };
  }

  return (
    <div className="tc-trip-map" data-tone={tone}>
      <MapIcon />
      <span role="status">{text}</span>
      {action ? (
        <button type="button" onClick={action.run} disabled={disabled && action.run === onDownload}>
          {action.label}
        </button>
      ) : null}
      {percent != null ? (
        <span className="tc-trip-map-bar" aria-hidden>
          <span style={{ width: `${percent}%` }} />
        </span>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
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

function MapIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
      <path
        d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Zm0 0v14m6-12v14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
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
