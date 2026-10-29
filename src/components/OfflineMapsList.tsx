import { useEffect, useRef, useState } from 'react';
import { formatSavedAt } from '../routing/route-naming';
import {
  mapDataDate,
  mapDetail,
  mapPackService,
  type MapPackJob,
  type MapPackMeta,
} from '../services/map-pack.service';
import { importSummary, routeLibrary } from '../services/route-library.service';
import { shareFile } from '../services/share-file';
import { SaveAreaSheet } from './SaveAreaSheet';

interface Notice {
  text: string;
  tone: 'ok' | 'err';
}

/**
 * Areas and trips kept for riding without signal. They share tiles, so
 * maps that overlap take no extra space.
 */
export function OfflineMapsList() {
  const [packs, setPacks] = useState<MapPackMeta[] | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: 'share' | 'delete' } | null>(null);
  const [importing, setImporting] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [areaOpen, setAreaOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void mapPackService.list().then((list) => {
        if (alive) setPacks(list);
      });
    load();
    const off = mapPackService.subscribe(load);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = async (pack: MapPackMeta, action: 'share' | 'delete', work: () => Promise<string | null>) => {
    setBusy({ id: pack.id, action });
    setNotice(null);
    try {
      const text = await work();
      if (text) setNotice({ text, tone: 'ok' });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : 'Something went wrong', tone: 'err' });
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = (pack: MapPackMeta) =>
    run(pack, 'delete', async () => {
      await mapPackService.delete(pack.id);
      return `Deleted “${pack.name}”. Tiles other maps use are kept.`;
    });

  const handleShare = (pack: MapPackMeta) =>
    run(pack, 'share', async () => {
      if (pack.kind === 'route') {
        const route = pack.routeId ? await routeLibrary.get(pack.routeId) : null;
        if (!route) throw new Error('This trip is no longer in Library');
        const shared = await routeLibrary.exportAndShare(route, 'trailcompass', { withMap: true });
        return shared ? `Sharing “${pack.name}” with its map` : null;
      }
      const built = await mapPackService.buildShareFile(pack.id);
      if (!built) throw new Error('This map has no tiles saved yet');
      const shared = await shareFile(built.file, built.fileName, {
        title: pack.name,
        text: `TrailCompass offline map · ${pack.name} · ${mapDetail(pack.maxZoom).toLowerCase()}`,
        dialogTitle: 'Share map',
      });
      return shared ? `Sharing the “${pack.name}” map` : null;
    });

  const handleUpdate = (pack: MapPackMeta) => {
    setNotice(null);
    void mapPackService.update(pack.id).then(
      (meta) => {
        if (meta) setNotice({ text: `“${meta.name}” is up to date`, tone: 'ok' });
      },
      () => undefined,
    );
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImporting(0);
    setNotice(null);
    try {
      const outcome = await routeLibrary.importFromFile(file, (done, total) =>
        setImporting(total > 0 ? Math.round((done / total) * 100) : 0),
      );
      setNotice({ text: importSummary(outcome), tone: 'ok' });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : 'Import failed', tone: 'err' });
    } finally {
      setImporting(null);
    }
  };

  const disk = packs ? mapPackService.diskBytes() : 0;

  return (
    <section className="tc-offline-section" aria-labelledby="tc-offline-maps-heading">
      <div className="tc-offline-section-head">
        <h2 className="tc-list-heading" id="tc-offline-maps-heading">
          Offline maps{disk > 0 ? ` · ${formatBytes(disk)}` : ''}
        </h2>
        <button
          type="button"
          className="tc-offline-link"
          disabled={importing != null}
          onClick={() => fileRef.current?.click()}
        >
          {importing != null ? `Importing ${importing}%` : 'Import'}
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".pmtiles,application/octet-stream"
        hidden
        onChange={(e) => void handleFileChange(e)}
      />
      <p className="tc-offline-hint">
        Save a city or state here, or a trip's map from Library. Maps share
        tiles, so overlapping ones don't take space twice.
      </p>
      <button type="button" className="tc-btn tc-offline-add-area" onClick={() => setAreaOpen(true)}>
        Save an area
      </button>

      {notice ? (
        <p className={notice.tone === 'err' ? 'tc-offline-status tc-offline-status-err' : 'tc-offline-status'} role="status">
          {notice.text}
        </p>
      ) : null}

      {packs == null ? (
        <p className="tc-offline-hint">Loading…</p>
      ) : packs.length === 0 ? (
        <p className="tc-offline-hint">No offline maps yet.</p>
      ) : (
        <ul className="tc-offline-packs tc-offline-maps">
          {packs.map((pack) => (
            <MapRow
              key={pack.id}
              pack={pack}
              job={mapPackService.getJob(pack.id)}
              busy={busy?.id === pack.id ? busy.action : null}
              disabled={busy != null}
              onUpdate={() => handleUpdate(pack)}
              onCancel={() => mapPackService.cancel(pack.id)}
              onShare={() => void handleShare(pack)}
              onDelete={() => void handleDelete(pack)}
            />
          ))}
        </ul>
      )}

      <SaveAreaSheet
        open={areaOpen}
        onClose={() => setAreaOpen(false)}
        onSaving={(name) => setNotice({ text: `Saving the “${name}” map`, tone: 'ok' })}
      />
    </section>
  );
}

function MapRow({
  pack,
  job,
  busy,
  disabled,
  onUpdate,
  onCancel,
  onShare,
  onDelete,
}: {
  pack: MapPackMeta;
  job: MapPackJob | undefined;
  busy: 'share' | 'delete' | null;
  disabled: boolean;
  onUpdate: () => void;
  onCancel: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  let status: string;
  let tone: 'ok' | 'err' | undefined;
  let action: { label: string; run: () => void } | null = null;
  let percent: number | null = null;
  const active = job != null && job.state !== 'error';

  if (job?.state === 'downloading') {
    percent = job.total > 0 ? Math.round((job.done / job.total) * 100) : 100;
    status = job.retrying
      ? `Saving · ${percent}% · trying ${job.retrying} tile${job.retrying === 1 ? '' : 's'} again`
      : job.total > 0
        ? `Saving · ${percent}%`
        : 'Checking…';
    action = { label: 'Stop', run: onCancel };
  } else if (job?.state === 'queued') {
    status = 'Waiting for another download';
    action = { label: 'Stop', run: onCancel };
  } else if (job?.state === 'waiting-wifi') {
    status = 'Waits for Wi-Fi';
    action = { label: 'Stop', run: onCancel };
  } else if (job?.state === 'error') {
    status = job.message;
    tone = 'err';
    action = { label: 'Retry', run: onUpdate };
  } else if (pack.saved < pack.tiles) {
    status = `${Math.floor((pack.saved / Math.max(1, pack.tiles)) * 100)}% saved`;
    action = { label: 'Resume', run: onUpdate };
  } else {
    status = downloadedText(pack);
    tone = 'ok';
    action = { label: 'Update', run: onUpdate };
  }

  return (
    <li className="tc-offline-pack tc-offline-map">
      <span className="tc-offline-map-kind" data-kind={pack.kind} aria-hidden>
        {pack.kind === 'area' ? <AreaIcon /> : <TripIcon />}
      </span>
      <div className="tc-offline-pack-text">
        <strong>{pack.name}</strong>
        <span>
          {[pack.kind === 'area' ? 'Area' : 'Trip', mapDetail(pack.maxZoom), formatBytes(pack.bytes)].join(' · ')}
        </span>
      </div>
      <button
        type="button"
        className="tc-offline-icon-btn tc-offline-icon-btn-plain"
        aria-label={`Share ${pack.name}`}
        disabled={disabled || active || pack.saved === 0}
        onClick={onShare}
      >
        {busy === 'share' ? <span className="tc-spinner tc-spinner-sm" aria-hidden /> : <ShareIcon />}
      </button>
      <button
        type="button"
        className="tc-offline-icon-btn"
        aria-label={`Delete ${pack.name}`}
        disabled={disabled}
        onClick={onDelete}
      >
        {busy === 'delete' ? <span className="tc-spinner tc-spinner-sm" aria-hidden /> : <TrashIcon />}
      </button>
      <div className="tc-trip-map" data-tone={tone}>
        <span role="status">{status}</span>
        {action ? (
          <button type="button" onClick={action.run} disabled={disabled && !active}>
            {action.label}
          </button>
        ) : null}
        {percent != null ? (
          <span className="tc-trip-map-bar" aria-hidden>
            <span style={{ width: `${percent}%` }} />
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** "Downloaded today 14:16 · map data 25 Oct" */
function downloadedText(pack: MapPackMeta): string {
  const built = mapDataDate(pack.planet);
  return [
    pack.downloadedAt ? `Downloaded ${formatSavedAt(pack.downloadedAt)}` : 'Saved',
    built ? `map data ${built.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : null,
    pack.trimmed ? 'size limit reached' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AreaIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path
        d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Zm0 0v14m6-12v14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TripIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <circle cx="6" cy="18" r="2.2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path
        d="M12 15V4m0 0L8 8m4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
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
