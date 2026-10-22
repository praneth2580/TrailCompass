import { useState } from 'react';
import {
  ROUTING_PROFILES,
  getProfile,
  type RoutingProfileId,
} from '../routing/routing-profiles';
import type { CalculatedRoute } from '../routing/routing-adapter';

const ROUTE_SWATCHES = ['#5b8def', '#9b7bff', '#3dbea5'];

interface RouteOptionsPanelProps {
  profile: RoutingProfileId;
  alternatives: CalculatedRoute[];
  selectedIndex: number;
  showAllRoutes: boolean;
  visible: boolean;
  onProfileChange: (profile: RoutingProfileId) => void;
  onSelectAlternative: (index: number) => void;
  onToggleShowAll: (showAll: boolean) => void;
}

export function RouteOptionsPanel({
  profile,
  alternatives,
  selectedIndex,
  showAllRoutes,
  visible,
  onProfileChange,
  onSelectAlternative,
  onToggleShowAll,
}: RouteOptionsPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [routesSeen, setRoutesSeen] = useState(0);
  const hasRoutes = alternatives.length > 0;

  // Re-open the sheet when a new set of routes arrives so picking is obvious.
  if (hasRoutes && alternatives.length !== routesSeen) {
    setRoutesSeen(alternatives.length);
    if (!expanded) setExpanded(true);
  } else if (!hasRoutes && routesSeen !== 0) {
    setRoutesSeen(0);
  }

  if (!visible) return null;

  const activeProfile = getProfile(profile);
  const selected = alternatives[selectedIndex];

  return (
    <section
      className={
        expanded
          ? 'tc-route-sheet'
          : 'tc-route-sheet tc-route-sheet-collapsed'
      }
      aria-label="Route options"
    >
      <button
        type="button"
        className="tc-route-sheet-handle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="tc-route-sheet-grip" aria-hidden />
        <span className="tc-route-sheet-summary">
          <strong>
            {hasRoutes
              ? `Taking: ${routeLabel(selected ?? alternatives[0]!, selectedIndex)}`
              : activeProfile.label}
          </strong>
          {selected ? (
            <span>
              {formatKm(selected.distanceMeters)} ·{' '}
              {formatEta(selected.durationSeconds)}
              {alternatives.length > 1
                ? ` · tap a card or map line to switch`
                : ''}
            </span>
          ) : (
            <span>Choose preference, then plan</span>
          )}
        </span>
        <span className="tc-route-sheet-chevron" aria-hidden>
          {expanded ? '▾' : '▴'}
        </span>
      </button>

      {expanded ? (
        <div className="tc-route-sheet-body">
          <div className="tc-route-section">
            <p className="tc-route-section-label">Route type</p>
            <div
              className="tc-route-type"
              role="radiogroup"
              aria-label="Route type"
            >
              {ROUTING_PROFILES.map((p) => {
                const active = profile === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={
                      active
                        ? 'tc-route-type-option tc-route-type-option-active'
                        : 'tc-route-type-option'
                    }
                    title={p.description}
                    onClick={() => onProfileChange(p.id)}
                  >
                    <span className="tc-route-type-icon" aria-hidden>
                      <ProfileIcon id={p.id} />
                    </span>
                    <span className="tc-route-type-title">{p.label}</span>
                    <span className="tc-route-type-hint">
                      {profileHint(p.id)}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="tc-route-type-desc" key={activeProfile.id}>
              <span className="tc-route-type-desc-label">
                {activeProfile.label}
              </span>
              {activeProfile.description}
            </p>
          </div>

          {hasRoutes ? (
            <div className="tc-route-section">
              <div className="tc-route-section-row">
                <p className="tc-route-section-label">
                  {alternatives.length === 1
                    ? 'Your route'
                    : 'Pick the route you will take'}
                </p>
                {alternatives.length > 1 ? (
                  <button
                    type="button"
                    className={
                      showAllRoutes
                        ? 'tc-route-toggle tc-route-toggle-on'
                        : 'tc-route-toggle'
                    }
                    aria-pressed={showAllRoutes}
                    onClick={() => onToggleShowAll(!showAllRoutes)}
                  >
                    {showAllRoutes ? 'Showing all' : 'Show all on map'}
                  </button>
                ) : null}
              </div>

              <div
                className="tc-route-cards"
                role="listbox"
                aria-label="Available routes"
              >
                {alternatives.map((route, index) => {
                  const active = index === selectedIndex;
                  const swatch = ROUTE_SWATCHES[index % ROUTE_SWATCHES.length]!;
                  return (
                    <button
                      key={route.id ?? index}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={
                        active
                          ? 'tc-route-card tc-route-card-active'
                          : 'tc-route-card'
                      }
                      onClick={() => onSelectAlternative(index)}
                    >
                      <span
                        className="tc-route-card-swatch"
                        style={{ background: swatch }}
                        aria-hidden
                      />
                      <span className="tc-route-card-body">
                        <span className="tc-route-card-title">
                          {routeLabel(route, index)}
                          {index === 0 ? (
                            <span className="tc-route-card-badge">Best</span>
                          ) : null}
                        </span>
                        <span className="tc-route-card-meta">
                          <span>{formatKm(route.distanceMeters)}</span>
                          <span aria-hidden>·</span>
                          <span>{formatEta(route.durationSeconds)}</span>
                        </span>
                      </span>
                      <span
                        className={
                          active
                            ? 'tc-route-card-action tc-route-card-action-on'
                            : 'tc-route-card-action'
                        }
                      >
                        {active ? 'Taking' : 'Take'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="tc-route-empty">
              Set a destination and tap Plan route to compare options.
            </p>
          )}

          {alternatives.length > 1 ? (
            <p className="tc-route-footnote">
              Tap a card, or a colored line on the map, to choose your route.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function routeLabel(route: CalculatedRoute, index: number): string {
  if (route.label && route.label !== 'Best match') return route.label;
  if (index === 0) return 'Primary';
  return `Option ${index + 1}`;
}

function profileHint(id: RoutingProfileId): string {
  switch (id) {
    case 'fastest':
      return 'Best ETA';
    case 'shortest':
      return 'Least km';
    case 'less_traffic':
      return 'Quieter roads';
    default:
      return '';
  }
}

function ProfileIcon({ id }: { id: RoutingProfileId }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    width: 18,
    height: 18,
  };

  switch (id) {
    case 'fastest':
      return (
        <svg {...common} aria-hidden>
          <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
        </svg>
      );
    case 'shortest':
      return (
        <svg {...common} aria-hidden>
          <path d="M4 12h16" />
          <path d="M7 8 4 12l3 4" />
          <path d="M17 8l3 4-3 4" />
        </svg>
      );
    case 'less_traffic':
      return (
        <svg {...common} aria-hidden>
          <path d="M4 18c2.5-4 5-6 8-6s5.5 2 8 6" />
          <path d="M8 10c1.2-1.8 2.6-2.8 4-2.8S14.8 8.2 16 10" />
          <circle cx="12" cy="5" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return null;
  }
}

function formatKm(meters: number): string {
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
