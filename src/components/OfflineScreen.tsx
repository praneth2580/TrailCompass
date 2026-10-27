import { useCallback, useEffect, useState } from 'react';
import type { OfflineEngineStatus } from '../routing/offline-adapter';
import {
  roadPackService,
  type RoadPackMeta,
} from '../services/road-pack.service';
import {
  checkForPoiUpdate,
  currentPoiData,
  lastPoiCheckAt,
  onPoiDataChanged,
  subscribePoiUpdates,
  type PoiManifest,
  type PoiUpdateStatus,
} from '../services/poi-data.service';

interface OfflineScreenProps {
  engine: OfflineEngineStatus;
}

export function OfflineScreen({ engine }: OfflineScreenProps) {
  const [packs, setPacks] = useState<RoadPackMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const list = await roadPackService.listPacks();
    setPacks(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    let alive = true;
    void roadPackService.listPacks().then((list) => {
      if (!alive) return;
      setPacks(list);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleDelete = async (id: string, label: string) => {
    setBusyId(id);
    setMessage(null);
    try {
      await roadPackService.deletePack(id);
      await reload();
      setMessage(`Deleted pack`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : `Could not delete ${label}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteAll = async () => {
    if (packs.length === 0) return;
    setBusyId('__all__');
    setMessage(null);
    try {
      await roadPackService.deleteAll();
      await reload();
      setMessage('All road packs deleted');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not delete packs');
    } finally {
      setBusyId(null);
    }
  };

  const totalBytes = packs.reduce((sum, p) => sum + p.bytes, 0);

  return (
    <main className="tc-main tc-main-downloads">
      <header className="tc-downloads-hero">
        <p className="tc-downloads-brand">TrailCompass</p>
        <h1 className="tc-section-title">Offline</h1>
        <p className="tc-section-copy">
          Saved road packs reuse streets you already downloaded. Delete packs
          you no longer need. Trips stay on Library.
        </p>
      </header>

      <section className="tc-storage" aria-label="Routing engine">
        <div className="tc-storage-row">
          <span className="tc-storage-label">Routing engine</span>
          <span className="tc-storage-value">
            {engine.ready ? engine.kind : 'none'}
          </span>
        </div>
        <p className="tc-section-copy">{engine.message}</p>
        {engine.attribution ? (
          <p className="tc-section-copy">{engine.attribution}</p>
        ) : null}
      </section>

      <PlacesDataSection />

      <div className="tc-saved-routes-header">
        <h2 className="tc-list-heading">Saved road packs</h2>
        {packs.length > 0 ? (
          <button
            type="button"
            className="tc-btn tc-btn-ghost tc-btn-danger-ghost"
            disabled={busyId != null}
            onClick={() => void handleDeleteAll()}
          >
            {busyId === '__all__' ? 'Deleting…' : 'Delete all'}
          </button>
        ) : null}
      </div>
      <p className="tc-section-copy">
        {loading
          ? 'Loading packs…'
          : packs.length === 0
            ? 'No packs yet — preview a trip to download and save roads for that area.'
            : `${packs.length} pack${packs.length === 1 ? '' : 's'} · ${formatBytes(totalBytes)}`}
      </p>
      {message ? (
        <p className="tc-saved-routes-msg" role="status">
          {message}
        </p>
      ) : null}

      <section className="tc-region-list" aria-label="Road packs">
        {packs.map((pack) => (
          <article key={pack.id} className="tc-region">
            <div className="tc-region-body">
              <h3 className="tc-region-name">{pack.label}</h3>
              <p className="tc-region-meta">
                {formatBytes(pack.bytes)} ·{' '}
                {new Date(pack.createdAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
            <button
              type="button"
              className="tc-btn tc-btn-ghost tc-btn-danger-ghost"
              disabled={busyId != null}
              onClick={() => void handleDelete(pack.id, pack.label)}
            >
              {busyId === pack.id ? '…' : 'Delete'}
            </button>
          </article>
        ))}
      </section>

      <h2 className="tc-list-heading">Engine</h2>
      <section className="tc-region-list" aria-label="Engine status">
        <article className="tc-region">
          <div className="tc-region-body">
            <h3 className="tc-region-name">
              {engine.network?.label ?? 'OSM road graph'}
            </h3>
            <p className="tc-region-meta">
              Active in-memory network for the current plan
            </p>
          </div>
          <span
            className={
              engine.ready
                ? 'tc-region-badge tc-region-badge-ok'
                : 'tc-region-badge'
            }
          >
            {engine.ready ? 'Ready' : 'Unavailable'}
          </span>
        </article>
        <article className="tc-region">
          <div className="tc-region-body">
            <h3 className="tc-region-name">Valhalla tiles</h3>
            <p className="tc-region-meta">
              Optional · place valhalla-tiles.tar in assets/routing
            </p>
          </div>
          <span className="tc-region-badge">
            {engine.kind === 'valhalla' ? 'Active' : 'Not loaded'}
          </span>
        </article>
      </section>
    </main>
  );
}

interface PlacesData {
  release: string | null;
  downloaded: boolean;
  fuel: number;
  food: number;
}

/** Which fuel and food data is in use, and checking GitHub for newer data. */
function PlacesDataSection() {
  const [data, setData] = useState<PlacesData | null>(null);
  const [status, setStatus] = useState<PoiUpdateStatus>({ state: 'idle' });
  const [checkedAt, setCheckedAt] = useState(() => lastPoiCheckAt());

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const location = await currentPoiData();
      const manifest = await fetch(`${location.base}/manifest.json`)
        .then((r) => (r.ok ? (r.json() as Promise<PoiManifest>) : null))
        .catch(() => null);
      if (!alive) return;
      setData({
        release: location.release ?? manifest?.release ?? null,
        downloaded: location.downloaded,
        fuel: manifest?.kinds.fuel?.count ?? 0,
        food: manifest?.kinds.food?.count ?? 0,
      });
    };
    void load();
    const offChanged = onPoiDataChanged(() => void load());
    const offStatus = subscribePoiUpdates((next) => {
      setStatus(next);
      setCheckedAt(lastPoiCheckAt());
    });
    return () => {
      alive = false;
      offChanged();
      offStatus();
    };
  }, []);

  const busy = status.state === 'checking' || status.state === 'downloading';

  return (
    <section className="tc-storage" aria-label="Fuel and food places">
      <div className="tc-storage-row">
        <span className="tc-storage-label">Fuel &amp; food places</span>
        <span className="tc-storage-value">
          {data?.release ? `Overture ${data.release}` : '—'}
        </span>
      </div>
      <p className="tc-section-copy">
        {data
          ? `${data.fuel.toLocaleString()} fuel stations · ${data.food.toLocaleString()} places to eat · ${data.downloaded ? 'downloaded update' : 'built into the app'}`
          : 'Loading…'}
      </p>
      <p className="tc-section-copy" role="status">
        {poiStatusText(status, checkedAt)}
      </p>
      <button
        type="button"
        className="tc-btn tc-btn-ghost"
        disabled={busy}
        onClick={() => void checkForPoiUpdate({ force: true })}
      >
        {status.state === 'downloading'
          ? `Downloading ${status.done}/${status.total}…`
          : status.state === 'checking'
            ? 'Checking…'
            : 'Check for updates'}
      </button>
    </section>
  );
}

function poiStatusText(status: PoiUpdateStatus, checkedAt: number | null): string {
  switch (status.state) {
    case 'checking':
      return 'Checking GitHub for newer data…';
    case 'downloading':
      return `Downloading Overture ${status.release}: ${status.done} of ${status.total} tiles`;
    case 'done':
    case 'error':
      return status.message;
    default:
      return checkedAt
        ? `Last checked ${new Date(checkedAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })} · checks daily when online`
        : 'Checks for newer data daily when online';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
