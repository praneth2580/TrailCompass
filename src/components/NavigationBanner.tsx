import type { NavigationState } from '../types/navigation';
import { formatInstructionBanner } from '../routing/turn-instructions';

interface NavigationBannerProps {
  state: NavigationState;
  onPlanDemo?: () => void;
  onStop?: () => void;
}

export function NavigationBanner({
  state,
  onPlanDemo,
  onStop,
}: NavigationBannerProps) {
  const text = formatInstructionBanner(
    state.currentInstruction,
    state.distanceToNextManeuverMeters,
  );

  return (
    <div className="tc-nav-banner" data-status={state.status}>
      <div className="tc-nav-banner-main">
        <span className="tc-nav-status">{state.status.toUpperCase()}</span>
        <p className="tc-nav-instruction">
          {state.message ?? text}
        </p>
        {state.offRoute && (
          <p className="tc-nav-offroute">Off route</p>
        )}
      </div>
      <div className="tc-nav-actions">
        {state.status === 'idle' || state.status === 'error' ? (
          <button type="button" className="tc-btn" onClick={onPlanDemo}>
            Plan route
          </button>
        ) : (
          <button type="button" className="tc-btn tc-btn-secondary" onClick={onStop}>
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
