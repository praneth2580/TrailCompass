import type { NavigationState } from '../types/navigation';
import type { GpsWarning } from '../services/location.service';
import { formatArrivalTime } from '../routing/route-naming';
import {
  formatInstructionBanner,
  formatManeuverDistance,
  maneuverKind,
  type ManeuverKind,
} from '../routing/turn-instructions';

interface NavigationBannerProps {
  state: NavigationState;
  canPlan?: boolean;
  navMode?: boolean;
  rideMode?: boolean;
  /** Shown while navigating when the GPS is weak or has gone quiet. */
  gpsWarning?: GpsWarning | null;
  /** The current time, for the arrival time while navigating. */
  nowMs?: number;
  canSaveRoute?: boolean;
  /** The trip was edited after this route was planned. */
  routeOutdated?: boolean;
  onPlan?: () => void;
  /** Set while planning can move to a background notification. */
  onRunInBackground?: () => void;
  onStart?: () => void;
  onStop?: () => void;
  onExitRide?: () => void;
  onSaveRoute?: () => void;
  onShareRoute?: () => void;
}

export function NavigationBanner({
  state,
  canPlan = true,
  navMode = false,
  rideMode = false,
  gpsWarning = null,
  nowMs,
  canSaveRoute = false,
  routeOutdated = false,
  onPlan,
  onRunInBackground,
  onStart,
  onStop,
  onExitRide,
  onSaveRoute,
  onShareRoute,
}: NavigationBannerProps) {
  const text = formatInstructionBanner(
    state.currentInstruction,
    state.distanceToNextManeuverMeters,
  );
  const choosing = state.status === 'choosing';
  const outdated = choosing && routeOutdated;
  const showPlan =
    state.status === 'idle' ||
    state.status === 'error' ||
    state.status === 'arrived' ||
    outdated;
  const progress = state.progress;
  const working =
    (state.status === 'planning' || state.status === 'rerouting') &&
    progress != null &&
    progress.phase !== 'idle';
  const instruction = working
    ? progress.label || state.message || 'Working…'
    : navMode || rideMode
      ? text
      : outdated
        ? 'Trip changed — plan again to update the route'
        : (state.message ?? text);
  // Mid-ride: a turn arrow, the distance to it, then what to do.
  const maneuver =
    (navMode || rideMode) && !working ? state.currentInstruction : undefined;
  const maneuverDistance = state.distanceToNextManeuverMeters;

  const bannerClass = showPlan
    ? 'tc-nav-banner tc-nav-banner-idle'
    : navMode || rideMode
      ? 'tc-nav-banner tc-nav-banner-nav'
      : choosing
        ? 'tc-nav-banner tc-nav-banner-choose'
        : 'tc-nav-banner';

  return (
    <div
      className={bannerClass}
      data-status={state.status}
      data-nav={navMode ? 'true' : undefined}
      data-ride={rideMode ? 'true' : undefined}
    >
      <div className="tc-nav-banner-main">
        {!navMode && !rideMode ? (
          <span className="tc-nav-status">{statusLabel(state.status)}</span>
        ) : null}
        {maneuver ? (
          <div className="tc-nav-maneuver">
            <ManeuverIcon kind={maneuverKind(maneuver)} />
            <div className="tc-nav-maneuver-copy">
              {maneuverDistance != null && Number.isFinite(maneuverDistance) ? (
                <p className="tc-nav-maneuver-distance">
                  {formatManeuverDistance(maneuverDistance)}
                </p>
              ) : null}
              <p className="tc-nav-instruction">{maneuver.text}</p>
            </div>
          </div>
        ) : (
          <div className={working ? 'tc-nav-working' : undefined}>
            {working ? <div className="tc-route-progress-spinner" aria-hidden /> : null}
            <div className="tc-nav-working-copy">
              <p className="tc-nav-instruction">{instruction}</p>
              {working ? <RouteProgress progress={progress} /> : null}
            </div>
          </div>
        )}
        {state.offRoute ? <p className="tc-nav-offroute">Off route</p> : null}
        {gpsWarning && (navMode || rideMode) ? (
          <p className="tc-nav-gps-warning" role="status" data-level={gpsWarning}>
            {gpsWarning === 'lost' ? 'No GPS signal' : 'Weak GPS signal'}
          </p>
        ) : null}
        {((choosing && !outdated) || navMode || state.status === 'rerouting') &&
        state.remainingDistanceMeters != null ? (
          <p className="tc-nav-remaining">
            {formatRemaining(state.remainingDistanceMeters)}
            {state.remainingDurationSeconds != null
              ? ` · ${formatEta(state.remainingDurationSeconds)}`
              : ''}
            {navMode && nowMs != null && state.remainingDurationSeconds != null
              ? ` · arrive ${formatArrivalTime(nowMs + state.remainingDurationSeconds * 1000)}`
              : ''}
          </p>
        ) : null}
        {state.status === 'planning' && onRunInBackground ? (
          <div className="tc-nav-route-tools">
            <button
              type="button"
              className="tc-tool-chip"
              onClick={onRunInBackground}
            >
              <BackgroundIcon />
              Run in background
            </button>
          </div>
        ) : canSaveRoute && !rideMode ? (
          <div className="tc-nav-route-tools">
            <button
              type="button"
              className="tc-tool-chip"
              onClick={onSaveRoute}
            >
              <SaveIcon />
              Save
            </button>
            <button
              type="button"
              className="tc-tool-chip"
              onClick={onShareRoute}
            >
              <ShareIcon />
              Share
            </button>
          </div>
        ) : null}
      </div>
      <div className="tc-nav-actions">
        {showPlan ? (
          <button
            type="button"
            className="tc-btn"
            onClick={onPlan}
            disabled={!canPlan}
          >
            Plan route
          </button>
        ) : choosing ? (
          <button type="button" className="tc-btn" onClick={onStart}>
            Start
          </button>
        ) : (
          <>
            {rideMode && onExitRide ? (
              <button
                type="button"
                className="tc-btn tc-btn-ghost"
                onClick={onExitRide}
              >
                Exit
              </button>
            ) : null}
            <button
              type="button"
              className="tc-btn tc-btn-secondary"
              onClick={onStop}
            >
              Stop
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** How much of the road data is in, once there's a size to measure against. */
export function RouteProgress({ progress }: { progress: NonNullable<NavigationState['progress']> }) {
  const { percent, bytesReceived, bytesTotal } = progress;
  if (percent == null || !Number.isFinite(percent) || bytesTotal == null || bytesTotal <= 0) return null;
  return (
    <>
      <div
        className="tc-route-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div className="tc-route-progress-fill" style={{ width: `${Math.round(percent)}%` }} />
      </div>
      <span className="tc-route-progress-pct">
        {Math.round(percent)}%
        {bytesReceived != null ? ` · ${formatBytes(bytesReceived)} / ${formatBytes(bytesTotal)}` : ''}
      </span>
    </>
  );
}

export function BackgroundIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden>
      <path
        d="M12 4v10m0 0-4-4m4 4 4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5 19h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function SaveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden>
      <path
        d="M6 4h10l4 4v12H6V4Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M9 4v5h8" stroke="currentColor" strokeWidth="2" />
      <path d="M9 15h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden>
      <circle cx="18" cy="5" r="2.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="6" cy="12" r="2.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="18" cy="19" r="2.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M8.3 10.7 15.7 6.3M8.3 13.3l7.4 4.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function statusLabel(status: NavigationState['status']): string {
  switch (status) {
    case 'choosing':
      return 'pick route';
    case 'navigating':
      return 'navigating';
    case 'rerouting':
      return 'rerouting';
    case 'planning':
      return 'planning';
    default:
      return status.replace(/_/g, ' ');
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 10 m steps below a kilometre, so the figure does not tick every metre. */
function formatRemaining(meters: number): string {
  if (meters >= 100_000) return `${Math.round(meters / 1000)} km`;
  if (meters >= 995) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 10) * 10} m`;
}

const MANEUVER_PATHS: Record<ManeuverKind, string[]> = {
  straight: ['M12 20V5', 'M6.5 10.5 12 5l5.5 5.5'],
  'slight-left': ['M15 20v-6.5L7.5 6', 'M7 12V6h6'],
  'slight-right': ['M9 20v-6.5L16.5 6', 'M17 12V6h-6'],
  left: ['M16 20v-7a3 3 0 0 0-3-3H5', 'M9 6l-4 4 4 4'],
  right: ['M8 20v-7a3 3 0 0 1 3-3h8', 'M15 6l4 4-4 4'],
  'sharp-left': ['M16 20V6l-9 9', 'M13 15H7V9'],
  'sharp-right': ['M8 20V6l9 9', 'M11 15h6V9'],
  uturn: ['M8 20V9a4 4 0 0 1 8 0v7', 'M12.5 12.5 16 16l3.5-3.5'],
  arrive: [
    'M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21Z',
    'M10 10.5a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  ],
};

/** Big turn arrow for the navigation banner. */
function ManeuverIcon({ kind }: { kind: ManeuverKind }) {
  return (
    <span className="tc-nav-maneuver-icon" data-kind={kind} aria-hidden>
      <svg viewBox="0 0 24 24" fill="none">
        {MANEUVER_PATHS[kind].map((d) => (
          <path
            key={d}
            d={d}
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
    </span>
  );
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}
