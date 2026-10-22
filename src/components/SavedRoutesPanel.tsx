import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type { SavedRoute } from '../types/route';
import { routeLibrary } from '../services/route-library.service';
import {
  formatDistanceShort,
  formatEtaShort,
} from '../routing/route-naming';

interface SavedRoutesPanelProps {
  onOpenRoute: (route: SavedRoute) => void;
  refreshKey?: number;
}

type RowAction = 'share' | 'delete' | null;

export function SavedRoutesPanel({
  onOpenRoute,
  refreshKey = 0,
}: SavedRoutesPanelProps) {
  const [routes, setRoutes] = useState<SavedRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [rowBusy, setRowBusy] = useState<{ id: string; action: RowAction }>({
    id: '',
    action: null,
  });
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<'ok' | 'err'>('ok');
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
    setMessage(null);
    try {
      const saved = await routeLibrary.importFromFile(file);
      await reload();
      setMessageTone('ok');
      setMessage(`Imported “${saved.name}”`);
    } catch (e) {
      setMessageTone('err');
      setMessage(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleShare = async (route: SavedRoute) => {
    setRowBusy({ id: route.id, action: 'share' });
    setMessage(null);
    try {
      await routeLibrary.exportAndShare(route, 'trailcompass');
      setMessageTone('ok');
      setMessage(
        Capacitor.isNativePlatform()
          ? `Sharing “${route.name}”`
          : `Downloaded “${route.name}”`,
      );
    } catch (e) {
      setMessageTone('err');
      setMessage(e instanceof Error ? e.message : 'Share failed');
    } finally {
      setRowBusy({ id: '', action: null });
    }
  };

  const handleDelete = async (id: string, name: string) => {
    setRowBusy({ id, action: 'delete' });
    try {
      await routeLibrary.delete(id);
      await reload();
      setMessageTone('ok');
      setMessage(`Deleted “${name}”`);
    } catch (e) {
      setMessageTone('err');
      setMessage(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setRowBusy({ id: '', action: null });
    }
  };

  const anyBusy = importing || rowBusy.action != null;

  return (
    <section className="tc-saved-routes" aria-label="Saved routes">
      <div className="tc-saved-routes-header">
        <h2 className="tc-list-heading">Saved routes</h2>
        <button
          type="button"
          className="tc-btn tc-btn-ghost"
          onClick={handleImportClick}
          disabled={anyBusy}
        >
          {importing ? (
            <>
              <span className="tc-spinner tc-spinner-sm" aria-hidden />
              Importing…
            </>
          ) : (
            'Import file'
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.geojson,application/json,.trailcompass.json"
          className="tc-file-input"
          onChange={(e) => void handleFileChange(e)}
        />
      </div>

      <p className="tc-section-copy">
        Share <code>.trailcompass.json</code> files between devices, then Open
        and Start on the map.
      </p>

      {message ? (
        <p
          className={
            messageTone === 'err'
              ? 'tc-saved-routes-msg tc-saved-routes-msg-err'
              : 'tc-saved-routes-msg'
          }
          role="status"
        >
          {message}
        </p>
      ) : null}

      {loading ? (
        <div className="tc-saved-loading" role="status">
          <span className="tc-spinner" aria-hidden />
          <span>Loading saved routes…</span>
        </div>
      ) : routes.length === 0 ? (
        <p className="tc-route-empty">No saved routes yet.</p>
      ) : (
        <ul className="tc-saved-list">
          {routes.map((route) => {
            const sharing =
              rowBusy.id === route.id && rowBusy.action === 'share';
            const deleting =
              rowBusy.id === route.id && rowBusy.action === 'delete';
            return (
              <li key={route.id} className="tc-saved-item">
                <div className="tc-saved-item-body">
                  <strong className="tc-saved-item-name">{route.name}</strong>
                  <span className="tc-saved-item-meta">
                    {formatDistanceShort(route.distanceMeters)} ·{' '}
                    {formatEtaShort(route.durationSeconds)} ·{' '}
                    {new Date(route.updatedAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <div className="tc-saved-item-actions">
                  <button
                    type="button"
                    className="tc-btn tc-btn-ghost"
                    onClick={() => onOpenRoute(route)}
                    disabled={anyBusy}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className="tc-btn tc-btn-ghost"
                    onClick={() => void handleShare(route)}
                    disabled={anyBusy}
                  >
                    {sharing ? (
                      <>
                        <span className="tc-spinner tc-spinner-sm" aria-hidden />
                        Sharing…
                      </>
                    ) : (
                      'Share'
                    )}
                  </button>
                  <button
                    type="button"
                    className="tc-btn tc-btn-ghost tc-btn-danger-ghost"
                    onClick={() => void handleDelete(route.id, route.name)}
                    disabled={anyBusy}
                  >
                    {deleting ? (
                      <>
                        <span className="tc-spinner tc-spinner-sm" aria-hidden />
                        …
                      </>
                    ) : (
                      'Delete'
                    )}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
