import type { NavigationState } from '../types/navigation';
import { formatInstructionBanner } from '../routing/turn-instructions';

interface NavigationBannerProps {
  state: NavigationState;
  canPlan?: boolean;
  navMode?: boolean;
  rideMode?: boolean;
  canSaveRoute?: boolean;
  onPlan?: () => void;
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
  onPlan,
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
  const showPlan =
    state.status === 'idle' ||
    state.status === 'error' ||
    state.status === 'arrived';
  const instruction =
    navMode || rideMode ? text : (state.message ?? text);

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
        <p className="tc-nav-instruction">{instruction}</p>
        {state.offRoute ? <p className="tc-nav-offroute">Off route</p> : null}
        {(choosing || navMode || state.status === 'rerouting') &&
        state.remainingDistanceMeters != null ? (
          <p className="tc-nav-remaining">
            {formatRemaining(state.remainingDistanceMeters)}
            {state.remainingDurationSeconds != null
              ? ` · ${formatEta(state.remainingDurationSeconds)}`
              : ''}
          </p>
        ) : null}
        {canSaveRoute && !rideMode ? (
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
