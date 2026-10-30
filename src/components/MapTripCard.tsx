import type { ReactNode } from 'react';
import { formatArrivalTime, formatDistanceShort, formatEtaShort } from '../routing/route-naming';
import type { NavigationState } from '../types/navigation';
import { BackgroundIcon, RouteProgress, SaveIcon, ShareIcon } from './NavigationBanner';
import { PinIcon } from './RideGroupLists';

/** The colours the route options are drawn in on the map. */
const ROUTE_SWATCHES = ['#5b8def', '#9b7bff', '#3dbea5'];

interface MapTripCardProps {
  state: NavigationState;
  destinationName: string | null;
  stopCount: number;
  /** Straight-line distance to the destination, when the rider's position is known. */
  awayMeters: number | null;
  canPlan: boolean;
  /** Why a route can't be planned yet, while road data gets ready. */
  routingNote: string | null;
  /** The trip was edited after this route was planned. */
  routeOutdated: boolean;
  nowMs: number;
  canSave: boolean;
  /** How to route, folded away under the actions. */
  options: ReactNode;
  onSearch: () => void;
  onClear: () => void;
  onEditTrip: () => void;
  onPlan: () => void;
  /** Set while planning can move to a background notification. */
  onRunInBackground?: () => void;
  onStop: () => void;
  onStart: () => void;
  onSelectRoute: (index: number) => void;
  onSave: () => void;
  onShare: () => void;
}

/** The Map tab's one card, from "Where to?" to Start. Riding, NavigationBanner takes over. */
export function MapTripCard({
  state,
  destinationName,
  stopCount,
  awayMeters,
  canPlan,
  routingNote,
  routeOutdated,
  nowMs,
  canSave,
  options,
  onSearch,
  onClear,
  onEditTrip,
  onPlan,
  onRunInBackground,
  onStop,
  onStart,
  onSelectRoute,
  onSave,
  onShare,
}: MapTripCardProps) {
  const failed = state.status === 'error' ? (state.message ?? 'Could not plan a route') : null;

  if (state.status === 'planning') {
    const progress = state.progress;
    return (
      <div className="tc-mapcard" data-state="planning">
        <div className="tc-mapcard-head">
          <span className="tc-route-progress-spinner" aria-hidden />
          <div className="tc-mapcard-title" role="status">
            <strong>{destinationName ? `Planning to ${destinationName}` : 'Planning your route'}</strong>
            <span>{progress?.label || state.message || 'Working…'}</span>
          </div>
        </div>
        {progress ? <RouteProgress progress={progress} /> : null}
        <div className="tc-mapcard-actions">
          {onRunInBackground ? (
            <button type="button" className="tc-tool-chip" onClick={onRunInBackground}>
              <BackgroundIcon />
              Run in background
            </button>
          ) : null}
          <button type="button" className="tc-btn tc-btn-sm tc-btn-secondary" onClick={onStop}>
            Stop
          </button>
        </div>
      </div>
    );
  }

  if (state.status === 'arrived') {
    return (
      <div className="tc-mapcard" data-state="arrived">
        <div className="tc-mapcard-head">
          <span className="tc-mapcard-pin" aria-hidden>
            <PinIcon />
          </span>
          <div className="tc-mapcard-title" role="status">
            <strong>You've arrived</strong>
            {destinationName ? <span>{destinationName}</span> : null}
          </div>
        </div>
        <button type="button" className="tc-btn" onClick={onClear}>
          Done
        </button>
      </div>
    );
  }

  if (!destinationName) {
    return (
      <>
        {failed ? (
          <p className="tc-mapcard-alert" role="alert">
            {failed}
          </p>
        ) : null}
        <button type="button" className="tc-mapcard-search" onClick={onSearch}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
            <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span>
            <strong>Where to?</strong>
            <small>{routingNote ?? 'Search a place, or tap the map'}</small>
          </span>
        </button>
      </>
    );
  }

  const choosing = state.status === 'choosing' && !routeOutdated;
  const routes = state.alternatives ?? [];
  const selectedIndex = state.selectedAlternativeIndex ?? 0;
  const seconds = state.remainingDurationSeconds;
  const meters = state.remainingDistanceMeters;
  const stops = stopCount > 0 ? `${stopCount} ${stopCount === 1 ? 'stop' : 'stops'}` : null;
  const facts = choosing
    ? [
        seconds != null ? formatEtaShort(seconds) : null,
        meters != null ? formatDistanceShort(meters) : null,
        seconds != null ? `arrive ${formatArrivalTime(nowMs + seconds * 1000)}` : null,
        stops,
      ]
    : [awayMeters != null ? `${formatDistanceShort(awayMeters)} away` : null, stops];

  return (
    <div className="tc-mapcard" data-state={choosing ? 'choosing' : 'destination'}>
      <div className="tc-mapcard-head">
        <span className="tc-mapcard-pin" aria-hidden>
          <PinIcon />
        </span>
        <div className="tc-mapcard-title">
          <strong>{destinationName}</strong>
          <span>{facts.filter(Boolean).join(' · ')}</span>
        </div>
        {/* A trip with stops is changed on the Plan tab: one tap shouldn't lose them. */}
        {stopCount === 0 ? (
          <button type="button" className="tc-mapcard-icon" aria-label="Clear this destination" title="Clear" onClick={onClear}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>

      {failed ? (
        <p className="tc-mapcard-alert" role="alert">
          {failed}
        </p>
      ) : routeOutdated ? (
        <p className="tc-mapcard-note">The trip changed. Plan again to update the route.</p>
      ) : null}

      {choosing && routes.length > 1 ? (
        <div className="tc-mapcard-routes" role="radiogroup" aria-label="Routes">
          {routes.map((route, index) => (
            <button
              key={route.id ?? index}
              type="button"
              role="radio"
              aria-checked={index === selectedIndex}
              onClick={() => onSelectRoute(index)}
            >
              <i style={{ background: ROUTE_SWATCHES[index % ROUTE_SWATCHES.length] }} aria-hidden />
              <strong>{formatEtaShort(route.durationSeconds)}</strong>
              <span>{formatDistanceShort(route.distanceMeters)}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="tc-mapcard-actions">
        {choosing ? (
          <button type="button" className="tc-btn" onClick={onStart}>
            Start
          </button>
        ) : (
          <button type="button" className="tc-btn" onClick={onPlan} disabled={!canPlan}>
            {failed ? 'Try again' : 'Plan route'}
          </button>
        )}
        <button type="button" className="tc-mapcard-icon" aria-label="Add or change stops" title="Stops" onClick={onEditTrip}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
        {choosing && canSave ? (
          <>
            <button type="button" className="tc-mapcard-icon" aria-label="Save this route" title="Save" onClick={onSave}>
              <SaveIcon />
            </button>
            <button type="button" className="tc-mapcard-icon" aria-label="Share this route" title="Share" onClick={onShare}>
              <ShareIcon />
            </button>
          </>
        ) : null}
      </div>

      {!canPlan && routingNote ? <p className="tc-mapcard-note">{routingNote}</p> : null}
      {options}
    </div>
  );
}
