import { useState } from 'react';
import {
  packKind,
  ROAD_PACK_KINDS,
  totalPackBytes,
  type RoadPackMeta,
} from '../services/road-pack.service';
import { formatSavedAt } from '../routing/route-naming';

interface RoadDataListProps {
  packs: RoadPackMeta[];
  loading: boolean;
  /** The pack being deleted, or '__all__'. */
  busyId: string | null;
  message: string | null;
  onDelete: (pack: RoadPackMeta) => void;
  onDeleteAll: () => void;
}

/** Saved road packs by kind, each deletable, with a confirmed Delete all. */
export function RoadDataList({
  packs,
  loading,
  busyId,
  message,
  onDelete,
  onDeleteAll,
}: RoadDataListProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="tc-offline-section" aria-labelledby="tc-road-data-heading">
      <div className="tc-offline-section-head">
        <h2 className="tc-list-heading" id="tc-road-data-heading">
          Saved road data
        </h2>
        {packs.length > 0 && !confirming ? (
          <button
            type="button"
            className="tc-offline-link tc-offline-link-danger"
            disabled={busyId != null}
            onClick={() => setConfirming(true)}
          >
            {busyId === '__all__' ? 'Deleting…' : 'Delete all'}
          </button>
        ) : null}
      </div>
      <p className="tc-offline-hint">
        Planning again in these areas skips the download. The oldest are
        cleared automatically.
      </p>

      {confirming ? (
        <div className="tc-offline-confirm" role="group" aria-label="Delete all road data">
          <p>
            Delete all {formatBytes(totalPackBytes(packs))} of saved road data?
            Trips download what they need again when you plan them.
          </p>
          <div className="tc-offline-confirm-actions">
            <button
              type="button"
              className="tc-btn tc-btn-secondary"
              onClick={() => setConfirming(false)}
            >
              Keep
            </button>
            <button
              type="button"
              className="tc-btn tc-btn-danger"
              onClick={() => {
                setConfirming(false);
                onDeleteAll();
              }}
            >
              Delete all
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p className="tc-offline-status" role="status">
          {message}
        </p>
      ) : null}

      {loading ? (
        <p className="tc-offline-hint">Loading…</p>
      ) : packs.length === 0 ? (
        <p className="tc-offline-hint">Nothing saved right now.</p>
      ) : (
        <div className="tc-offline-groups">
          {ROAD_PACK_KINDS.map(({ kind, title, hint }) => {
            const group = packs.filter((pack) => packKind(pack) === kind);
            if (group.length === 0) return null;
            return (
              <details key={kind} className="tc-offline-group">
                <summary>
                  <span className="tc-offline-swatch" data-kind={kind} aria-hidden />
                  <span className="tc-offline-group-text">
                    <strong>{title}</strong>
                    <span>
                      {group.length} area{group.length === 1 ? '' : 's'} ·{' '}
                      {formatBytes(totalPackBytes(group))}
                    </span>
                  </span>
                  <ChevronIcon />
                </summary>
                <p className="tc-offline-group-hint">{hint}.</p>
                <ul className="tc-offline-packs">
                  {group.map((pack) => (
                    <li key={pack.id} className="tc-offline-pack">
                      <div className="tc-offline-pack-text">
                        <strong>{packTitle(pack)}</strong>
                        <span>{packDetail(pack)}</span>
                      </div>
                      <button
                        type="button"
                        className="tc-offline-icon-btn"
                        aria-label={`Delete ${title.toLowerCase()}: ${packTitle(pack)}`}
                        disabled={busyId != null}
                        onClick={() => onDelete(pack)}
                      >
                        {busyId === pack.id ? (
                          <span className="tc-spinner tc-spinner-sm" aria-hidden />
                        ) : (
                          <TrashIcon />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Its main roads by name, or where it is. */
function packTitle(pack: RoadPackMeta): string {
  return pack.roads?.length ? pack.roads.join(' · ') : formatPlace(pack);
}

function packDetail(pack: RoadPackMeta): string {
  const parts = [formatBytes(pack.bytes), `saved ${formatSavedAt(pack.createdAt)}`];
  if (packKind(pack) !== 'backbone') parts.unshift(`about ${spanKm(pack)} km across`);
  if (pack.roads?.length) parts.unshift(formatPlace(pack));
  return parts.join(' · ');
}

/** The middle of the pack, e.g. "18.75° N, 73.25° E". */
function formatPlace(pack: RoadPackMeta): string {
  const [west, south, east, north] = pack.bbox;
  const lat = (south + north) / 2;
  const lon = (west + east) / 2;
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
}

function spanKm(pack: RoadPackMeta): number {
  const [west, south, east, north] = pack.bbox;
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const km = Math.max((east - west) * 111 * Math.cos(midLat), (north - south) * 111);
  return Math.max(1, Math.round(km));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ChevronIcon() {
  return (
    <svg className="tc-offline-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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
