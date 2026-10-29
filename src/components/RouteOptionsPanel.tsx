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
  allowExpressways: boolean;
  onAllowExpresswaysChange: (allow: boolean) => void;
  voiceGuidance: boolean;
  onVoiceGuidanceChange: (enabled: boolean) => void;
  onSelectAlternative: (index: number) => void;
  onStartNavigation: (index: number) => void;
  onToggleShowAll: (showAll: boolean) => void;
}

export function RouteOptionsPanel({
  profile,
  alternatives,
  selectedIndex,
  showAllRoutes,
  visible,
  onProfileChange,
  allowExpressways,
  onAllowExpresswaysChange,
  voiceGuidance,
  onVoiceGuidanceChange,
  onSelectAlternative,
  onStartNavigation,
  onToggleShowAll,
}: RouteOptionsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [routesSeen, setRoutesSeen] = useState(0);
  const hasRoutes = alternatives.length > 0;

  // Open when new alternatives arrive so the rider can pick one.
  if (hasRoutes && alternatives.length !== routesSeen) {
    setRoutesSeen(alternatives.length);
    setExpanded(true);
  } else if (!hasRoutes && routesSeen !== 0) {
    setRoutesSeen(0);
  }

  if (!visible) return null;

  const selected = alternatives[selectedIndex] ?? alternatives[0];

  return (
    <section
      className={expanded ? 'tc-route-sheet' : 'tc-route-sheet tc-route-sheet-collapsed'}
      aria-label="Route options"
    >
      <button
        type="button"
        className="tc-route-sheet-handle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="tc-route-sheet-icon" aria-hidden>
          <ProfileIcon id={profile} />
        </span>
        <span className="tc-route-sheet-summary">
          {selected ? (
            <>
              <strong>{routeLabel(selected, selectedIndex)}</strong>
              <span>
                {formatKm(selected.distanceMeters)} · {formatEta(selected.durationSeconds)}
              </span>
            </>
          ) : (
            <>
              <strong>{getProfile(profile).label}</strong>
              <span>
                {allowExpressways ? 'Expressways allowed' : 'No expressways'}
                {voiceGuidance ? ' · Voice on' : ''}
              </span>
            </>
          )}
        </span>
        <span className="tc-route-sheet-chevron" aria-hidden>
          {expanded ? '▾' : '▴'}
        </span>
      </button>

      {expanded ? (
        <div className="tc-route-sheet-body">
          <div className="tc-route-type" role="radiogroup" aria-label="Route type">
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
                  <ProfileIcon id={p.id} />
                  {p.label}
                </button>
              );
            })}
          </div>

          <div className="tc-route-switches">
            <Switch
              label="Expressways"
              checked={allowExpressways}
              onChange={onAllowExpresswaysChange}
            />
            <Switch
              label="Voice prompts"
              checked={voiceGuidance}
              onChange={onVoiceGuidanceChange}
            />
          </div>
          {allowExpressways ? (
            <p className="tc-route-note">Most expressways in India ban two-wheelers.</p>
          ) : null}

          {hasRoutes ? (
            <div className="tc-route-list">
              {alternatives.length > 1 ? (
                <div className="tc-route-list-head">
                  <span>Pick a route</span>
                  <button
                    type="button"
                    className="tc-route-show-all"
                    aria-pressed={showAllRoutes}
                    onClick={() => onToggleShowAll(!showAllRoutes)}
                  >
                    {showAllRoutes ? 'Hide others' : 'Show all on map'}
                  </button>
                </div>
              ) : null}
              <div className="tc-route-cards" role="listbox" aria-label="Available routes">
                {alternatives.map((route, index) => {
                  const active = index === selectedIndex;
                  return (
                    <div
                      key={route.id ?? index}
                      role="option"
                      aria-selected={active}
                      className={active ? 'tc-route-card tc-route-card-active' : 'tc-route-card'}
                    >
                      <button
                        type="button"
                        className="tc-route-card-pick"
                        onClick={() => onSelectAlternative(index)}
                      >
                        <span
                          className="tc-route-card-swatch"
                          style={{ background: ROUTE_SWATCHES[index % ROUTE_SWATCHES.length] }}
                          aria-hidden
                        />
                        <span className="tc-route-card-title">
                          {routeLabel(route, index)}
                          {index === 0 ? <span className="tc-route-card-badge">Best</span> : null}
                        </span>
                        <span className="tc-route-card-meta">
                          {formatKm(route.distanceMeters)} · {formatEta(route.durationSeconds)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={
                          active
                            ? 'tc-route-card-action tc-route-card-action-on'
                            : 'tc-route-card-action'
                        }
                        onClick={() => onStartNavigation(index)}
                      >
                        Go
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="tc-route-switch"
      onClick={() => onChange(!checked)}
    >
      <span>{label}</span>
      <span className="tc-route-switch-track" aria-hidden>
        <span className="tc-route-switch-thumb" />
      </span>
    </button>
  );
}

function routeLabel(route: CalculatedRoute, index: number): string {
  if (route.label && route.label !== 'Best match') return route.label;
  if (index === 0) return 'Primary';
  return `Option ${index + 1}`;
}

function ProfileIcon({ id }: { id: RoutingProfileId }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    width: 16,
    height: 16,
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
