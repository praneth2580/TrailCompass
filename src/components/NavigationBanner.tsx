import type { NavigationState } from '../types/navigation';
import { formatInstructionBanner } from '../routing/turn-instructions';

interface NavigationBannerProps {
  state: NavigationState;
  canPlan?: boolean;
  navMode?: boolean;
  rideMode?: boolean;
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
  const showPercent =
    working &&
    progress.percent != null &&
    Number.isFinite(progress.percent) &&
    progress.bytesTotal != null &&
    progress.bytesTotal > 0;
  const instruction = working
    ? progress.label || state.message || 'Working…'
    : navMode || rideMode
      ? text
      : outdated
        ? 'Trip changed — plan again to update the route'
        : (state.message ?? text);

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
        <div className={working ? 'tc-nav-working' : undefined}>
          {working ? <div className="tc-route-progress-spinner" aria-hidden /> : null}
          <div className="tc-nav-working-copy">
            <p className="tc-nav-instruction">{instruction}</p>
            {showPercent && progress ? (
              <>
                <div
                  className="tc-route-progress-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress.percent!)}
                >
                  <div
                    className="tc-route-progress-fill"
                    style={{ width: `${Math.round(progress.percent!)}%` }}
                  />
                </div>
                <span className="tc-route-progress-pct">
                  {Math.round(progress.percent!)}%
                  {progress.bytesReceived != null && progress.bytesTotal != null
                    ? ` · ${formatBytes(progress.bytesReceived)} / ${formatBytes(progress.bytesTotal)}`
                    : ''}
                </span>
              </>
            ) : null}
          </div>
        </div>
        {state.offRoute ? <p className="tc-nav-offroute">Off route</p> : null}
        {((choosing && !outdated) || navMode || state.status === 'rerouting') &&
        state.remainingDistanceMeters != null ? (
          <p className="tc-nav-remaining">
            {formatRemaining(state.remainingDistanceMeters)}
            {state.remainingDurationSeconds != null
              ? ` · ${formatEta(state.remainingDurationSeconds)}`
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

function SaveIcon() {
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

function ShareIcon() {
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

function formatRemaining(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}
