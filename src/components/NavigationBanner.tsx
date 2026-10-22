import type { NavigationState } from '../types/navigation';
import { formatInstructionBanner } from '../routing/turn-instructions';

interface NavigationBannerProps {
  state: NavigationState;
  canPlan?: boolean;
  onPlan?: () => void;
  onStop?: () => void;
}

export function NavigationBanner({
  state,
  canPlan = true,
  onPlan,
  onStop,
}: NavigationBannerProps) {
  const text = formatInstructionBanner(
    state.currentInstruction,
    state.distanceToNextManeuverMeters,
  );
  const showPlan =
    state.status === 'idle' ||
    state.status === 'error' ||
    state.status === 'arrived';
  const instruction = state.message ?? text;

  return (
    <div
      className={
        showPlan ? 'tc-nav-banner tc-nav-banner-idle' : 'tc-nav-banner'
      }
      data-status={state.status}
    >
      <div className="tc-nav-banner-main">
        <span className="tc-nav-status">{state.status.replace(/_/g, ' ')}</span>
        <p className="tc-nav-instruction">{instruction}</p>
        {state.offRoute ? <p className="tc-nav-offroute">Off route</p> : null}
        {state.remainingDistanceMeters != null &&
        state.status === 'navigating' ? (
          <p className="tc-nav-remaining">
            {formatRemaining(state.remainingDistanceMeters)} remaining
          </p>
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
        ) : (
          <button
            type="button"
            className="tc-btn tc-btn-secondary"
            onClick={onStop}
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

function formatRemaining(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}
