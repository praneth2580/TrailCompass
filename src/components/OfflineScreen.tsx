import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { OfflineEngineStatus } from '../routing/offline-adapter';
import {
  packKind,
  roadPackService,
  ROAD_PACK_KINDS,
  totalPackBytes,
  type RoadPackMeta,
} from '../services/road-pack.service';
import {
  checkForPoiUpdate,
  currentPoiData,
  formatPoiRelease,
  lastPoiCheckAt,
  onPoiDataChanged,
  subscribePoiUpdates,
  type PoiManifest,
  type PoiUpdateStatus,
} from '../services/poi-data.service';
import {
  checkForAppUpdate,
  installedAppVersion,
  showAppUpdatePrompt,
  subscribeAppUpdates,
  type AppUpdateStatus,
} from '../services/app-update.service';
import {
  downloadPolicy,
  type DownloadNetworks,
} from '../services/download-policy.service';
import type { NetworkType } from '../services/downloads-plugin';
import { RoadDataList } from './RoadDataList';

interface OfflineScreenProps {
  engine: OfflineEngineStatus;
}

interface PlacesData {
  release: string | null;
  downloaded: boolean;
  fuel: number;
  food: number;
}

export function OfflineScreen({ engine }: OfflineScreenProps) {
  const [packs, setPacks] = useState<RoadPackMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const places = usePlacesData();

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

  const handleDelete = async (pack: RoadPackMeta) => {
    setBusyId(pack.id);
    setMessage(null);
    try {
      await roadPackService.deletePack(pack.id);
      await reload();
      setMessage(`Deleted · ${formatBytes(pack.bytes)} freed`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't delete that road data");
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteAll = async () => {
    if (packs.length === 0) return;
    const freed = totalPackBytes(packs);
    setBusyId('__all__');
    setMessage(null);
    try {
      await roadPackService.deleteAll();
      await reload();
      setMessage(`Deleted all saved road data · ${formatBytes(freed)} freed`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't delete the road data");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="tc-main tc-main-downloads">
      <header className="tc-downloads-hero">
        <p className="tc-downloads-brand">TrailCompass</p>
        <h1 className="tc-section-title">Offline</h1>
        <p className="tc-section-copy">
          What's saved on this phone for riding with weak signal, and how it
          stays up to date.
        </p>
      </header>

      <OnThisPhone packs={packs} loading={loading} places={places} />

      <DownloadsSection />

      <UpdatesSection places={places} />

      <RoadDataList
        packs={packs}
        loading={loading}
        busyId={busyId}
        message={message}
        onDelete={(pack) => void handleDelete(pack)}
        onDeleteAll={() => void handleDeleteAll()}
      />

      <EngineDetails engine={engine} />
    </main>
  );
}

/** Which fuel and food data is in use; reloads after an update. */
function usePlacesData(): PlacesData | null {
  const [data, setData] = useState<PlacesData | null>(null);

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
    return () => {
      alive = false;
      offChanged();
    };
  }, []);

  return data;
}

/** At a glance: the road data saved, by kind, and the places built in. */
function OnThisPhone({
  packs,
  loading,
  places,
}: {
  packs: RoadPackMeta[];
  loading: boolean;
  places: PlacesData | null;
}) {
  const kinds = ROAD_PACK_KINDS.map((kind) => ({
    ...kind,
    bytes: totalPackBytes(packs.filter((pack) => packKind(pack) === kind.kind)),
  })).filter((kind) => kind.bytes > 0);

  return (
    <section className="tc-offline-section" aria-labelledby="tc-phone-heading">
      <h2 className="tc-list-heading" id="tc-phone-heading">
        On this phone
      </h2>
      <div className="tc-offline-card tc-offline-overview">
        {!loading && packs.length === 0 ? (
          <div className="tc-offline-none">
            <strong>No road data yet</strong>
            <span>
              Preview a trip while you have signal, and its roads are kept
              here for planning again.
            </span>
          </div>
        ) : (
          <>
            <div className="tc-offline-total">
              <strong>{loading ? '—' : formatBytes(totalPackBytes(packs))}</strong>
              <span>
                {loading
                  ? 'of road data'
                  : `of road data · ${packs.length} area${packs.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <div
              className="tc-offline-bar"
              role="img"
              aria-label={kinds.map((kind) => `${kind.title} ${formatBytes(kind.bytes)}`).join(', ')}
            >
              {kinds.map((kind) => (
                <span key={kind.kind} data-kind={kind.kind} style={{ flexGrow: kind.bytes }} />
              ))}
            </div>
          </>
        )}
        {kinds.length > 0 ? (
          <ul className="tc-offline-legend">
            {kinds.map((kind) => (
              <li key={kind.kind}>
                <span className="tc-offline-swatch" data-kind={kind.kind} aria-hidden />
                {kind.title} <b>{formatBytes(kind.bytes)}</b>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="tc-offline-places">
          <div className="tc-offline-stat">
            <FuelIcon />
            <strong>{places ? places.fuel.toLocaleString() : '—'}</strong>
            <span>fuel stations</span>
          </div>
          <div className="tc-offline-stat">
            <FoodIcon />
            <strong>{places ? places.food.toLocaleString() : '—'}</strong>
            <span>places to eat</span>
          </div>
        </div>
        <p className="tc-offline-hint">
          {places?.downloaded ? 'Downloaded to this phone' : 'Built into the app'}, so
          fuel and food suggestions work without signal.
        </p>
      </div>
    </section>
  );
}

const DOWNLOAD_NETWORKS: Array<{ value: DownloadNetworks; label: string }> = [
  { value: 'wifi', label: 'Wi-Fi only' },
  { value: 'any', label: 'Wi-Fi & mobile data' },
];

const NETWORK_LABELS: Record<NetworkType, string> = {
  wifi: 'Wi-Fi',
  cellular: 'Mobile data',
  other: 'Online',
  none: 'Offline',
  unknown: '',
};

/** Which networks large downloads may use. */
function DownloadsSection() {
  const [setting, setSetting] = useState(() => downloadPolicy.getSetting());
  const [network, setNetwork] = useState(() => downloadPolicy.getNetwork());

  useEffect(
    () =>
      downloadPolicy.subscribe(() => {
        setSetting(downloadPolicy.getSetting());
        setNetwork(downloadPolicy.getNetwork());
      }),
    [],
  );

  return (
    <section className="tc-offline-section" aria-labelledby="tc-downloads-heading">
      <h2 className="tc-list-heading" id="tc-downloads-heading">
        Downloads
      </h2>
      <div className="tc-offline-card tc-offline-downloads">
        <div className="tc-offline-card-head">
          <strong>Download over</strong>
          {network !== 'unknown' ? (
            <span className="tc-offline-net" data-network={network}>
              <NetworkIcon network={network} />
              {NETWORK_LABELS[network]}
            </span>
          ) : null}
        </div>
        <div
          className="tc-route-type tc-download-networks"
          role="radiogroup"
          aria-label="Download over"
        >
          {DOWNLOAD_NETWORKS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={setting === option.value}
              className={
                setting === option.value
                  ? 'tc-route-type-option tc-route-type-option-active'
                  : 'tc-route-type-option'
              }
              onClick={() => downloadPolicy.setSetting(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {setting === 'wifi' && network === 'cellular' ? (
          <p className="tc-offline-notice" role="status">
            You're on mobile data, so downloads wait for Wi-Fi.
          </p>
        ) : null}
        <p className="tc-offline-hint">
          Road data for planning, fuel &amp; food updates and app updates.
          Rerouting during a ride, the map and search always use any network.
        </p>
      </div>
    </section>
  );
}

/** The app and the fuel and food data, each with a Check button. */
function UpdatesSection({ places }: { places: PlacesData | null }) {
  const [version, setVersion] = useState<string | null>(null);
  const [app, setApp] = useState<AppUpdateStatus>({ state: 'idle' });
  const [poi, setPoi] = useState<PoiUpdateStatus>({ state: 'idle' });
  const [checkedAt, setCheckedAt] = useState(() => lastPoiCheckAt());

  useEffect(() => {
    let alive = true;
    void installedAppVersion().then((installed) => {
      if (alive) setVersion(installed);
    });
    const offApp = subscribeAppUpdates(setApp);
    const offPoi = subscribePoiUpdates((next) => {
      setPoi(next);
      setCheckedAt(lastPoiCheckAt());
    });
    return () => {
      alive = false;
      offApp();
      offPoi();
    };
  }, []);

  const appBusy = app.state === 'checking' || app.state === 'downloading';
  const poiBusy = poi.state === 'checking' || poi.state === 'downloading';

  return (
    <section className="tc-offline-section" aria-labelledby="tc-updates-heading">
      <h2 className="tc-list-heading" id="tc-updates-heading">
        Updates
      </h2>
      <div className="tc-offline-card tc-offline-rows">
        {/* Web preview: there is no APK to update. */}
        {version ? (
          <UpdateRow
            icon={<AppIcon />}
            title={`TrailCompass ${version}`}
            {...appUpdateText(app)}
            progress={
              app.state === 'downloading' && app.total > 0
                ? (app.bytes / app.total) * 100
                : null
            }
            action={
              app.state === 'available' ? (
                <button type="button" className="tc-btn" onClick={showAppUpdatePrompt}>
                  Update
                </button>
              ) : (
                <button
                  type="button"
                  className="tc-btn tc-btn-ghost"
                  disabled={appBusy}
                  onClick={() => void checkForAppUpdate({ force: true })}
                >
                  {app.state === 'checking' ? 'Checking…' : 'Check'}
                </button>
              )
            }
          />
        ) : null}
        <UpdateRow
          icon={<PlacesIcon />}
          title="Fuel & food places"
          {...poiStatusText(poi, places, checkedAt)}
          progress={
            poi.state === 'downloading' && poi.total > 0 ? (poi.done / poi.total) * 100 : null
          }
          action={
            <button
              type="button"
              className="tc-btn tc-btn-ghost"
              disabled={poiBusy}
              onClick={() => void checkForPoiUpdate({ force: true })}
            >
              {poi.state === 'checking' ? 'Checking…' : 'Check'}
            </button>
          }
        />
      </div>
      <p className="tc-offline-hint">Both check by themselves once a day when online.</p>
    </section>
  );
}

type Tone = 'ok' | 'accent' | 'danger' | undefined;

function UpdateRow({
  icon,
  title,
  text,
  tone,
  progress,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  tone?: Tone;
  progress: number | null;
  action: ReactNode;
}) {
  return (
    <div className="tc-offline-row">
      <span className="tc-offline-row-icon" aria-hidden>
        {icon}
      </span>
      <div className="tc-offline-row-text">
        <strong>{title}</strong>
        <span role="status" data-tone={tone}>
          {text}
        </span>
        {progress != null ? (
          <div className="tc-offline-progress" aria-hidden>
            <div style={{ width: `${Math.round(progress)}%` }} />
          </div>
        ) : null}
      </div>
      {action}
    </div>
  );
}

function appUpdateText(status: AppUpdateStatus): { text: string; tone?: Tone } {
  switch (status.state) {
    case 'checking':
      return { text: 'Looking for a new version…' };
    case 'up-to-date':
      return { text: 'Up to date', tone: 'ok' };
    case 'available':
      return { text: `Version ${status.release.version} is ready to install`, tone: 'accent' };
    case 'downloading':
      return { text: `Downloading version ${status.release.version}…` };
    case 'installing':
      return { text: `Installing version ${status.release.version}…` };
    case 'needs-permission':
      return { text: 'Allow TrailCompass to install updates to continue', tone: 'accent' };
    case 'error':
      return { text: status.message, tone: 'danger' };
    default:
      return { text: 'Installed' };
  }
}

function poiStatusText(
  status: PoiUpdateStatus,
  places: PlacesData | null,
  checkedAt: number | null,
): { text: string; tone?: Tone } {
  switch (status.state) {
    case 'checking':
      return { text: 'Looking for newer data…' };
    case 'downloading':
      return { text: `Downloading data from ${formatPoiRelease(status.release)}…` };
    case 'done':
      return { text: status.message, tone: status.message.startsWith('Updated') ? 'ok' : undefined };
    case 'error':
      return { text: status.message, tone: 'danger' };
    default: {
      const parts = [places?.release ? `Data from ${formatPoiRelease(places.release)}` : 'Loading…'];
      if (checkedAt) {
        parts.push(
          `checked ${new Date(checkedAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}`,
        );
      }
      return { text: parts.join(' · ') };
    }
  }
}

/** How routing works, for the curious; folded away by default. */
function EngineDetails({ engine }: { engine: OfflineEngineStatus }) {
  // The demo network loaded at start-up says nothing about the rider's roads.
  const network = engine.network && !engine.network.id.startsWith('demo') ? engine.network : null;

  return (
    <>
      <details className="tc-offline-details">
        <summary>
          <span className="tc-offline-details-title">How routing works</span>
          <span className={engine.ready ? 'tc-region-badge tc-region-badge-ok' : 'tc-region-badge'}>
            {engine.ready ? 'Ready' : 'Unavailable'}
          </span>
          <svg className="tc-offline-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
            <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </summary>
        <div className="tc-offline-details-body">
          <p className="tc-offline-hint">
            Routes are worked out on this phone, from OpenStreetMap roads
            downloaded for each trip. No online routing service is used.
          </p>
          <dl className="tc-offline-facts">
            <dt>Engine</dt>
            <dd>{engine.label}</dd>
            <dt>Status</dt>
            <dd>{engine.message}</dd>
            {network ? (
              <>
                <dt>Loaded now</dt>
                <dd>
                  {network.label} · {network.featureCount.toLocaleString()} roads
                </dd>
              </>
            ) : null}
            <dt>Valhalla</dt>
            <dd>
              {engine.kind === 'valhalla'
                ? 'In use'
                : 'Not included (optional tiles in assets/routing)'}
            </dd>
          </dl>
        </div>
      </details>
      <p className="tc-offline-credits">
        Road data © OpenStreetMap contributors (ODbL). Fuel and food places
        from the Overture Maps Foundation.
      </p>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function NetworkIcon({ network }: { network: NetworkType }) {
  if (network === 'wifi') {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden>
        <path
          d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="12" cy="19.5" r="1.4" fill="currentColor" />
      </svg>
    );
  }
  if (network === 'cellular') {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
        <rect x="3" y="15" width="3.5" height="6" rx="1" />
        <rect x="8.5" y="11" width="3.5" height="10" rx="1" />
        <rect x="14" y="7" width="3.5" height="14" rx="1" />
        <rect x="19.5" y="3" width="1.5" height="18" rx="0.75" opacity="0.4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
      {network === 'none' ? (
        <path d="M6.5 6.5l11 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

function FuelIcon() {
  return (
    <svg className="tc-offline-stat-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
      <path
        d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M7 8h4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8l-3-3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FoodIcon() {
  return (
    <svg className="tc-offline-stat-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
      <path
        d="M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17 21V3c-2.2 1.2-3.5 3.6-3.5 7v3H17"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AppIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="m14.8 9.2-1.9 3.7-3.7 1.9 1.9-3.7 3.7-1.9Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlacesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <path
        d="M12 21s-6.5-5.4-6.5-11a6.5 6.5 0 0 1 13 0c0 5.6-6.5 11-6.5 11Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10" r="2.3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
