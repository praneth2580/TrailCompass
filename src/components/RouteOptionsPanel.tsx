import { useState } from 'react';
import {
  ROUTING_PROFILES,
  getProfile,
  type RoutingProfileId,
} from '../routing/routing-profiles';

interface RouteOptionsPanelProps {
  profile: RoutingProfileId;
  onProfileChange: (profile: RoutingProfileId) => void;
  allowExpressways: boolean;
  onAllowExpresswaysChange: (allow: boolean) => void;
  voiceGuidance: boolean;
  onVoiceGuidanceChange: (enabled: boolean) => void;
}

/** How to route, folded to one line: most trips never need changing. */
export function RouteOptionsPanel({
  profile,
  onProfileChange,
  allowExpressways,
  onAllowExpresswaysChange,
  voiceGuidance,
  onVoiceGuidanceChange,
}: RouteOptionsPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <section className="tc-mapcard-options" aria-label="Route options">
      <button
        type="button"
        className="tc-mapcard-options-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ProfileIcon id={profile} />
        <span>
          {getProfile(profile).label} · {allowExpressways ? 'Expressways' : 'No expressways'}
          {voiceGuidance ? ' · Voice on' : ''}
        </span>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden data-open={open}>
          <path d="m6 15 6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div className="tc-mapcard-options-body">
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
            <Switch label="Expressways" checked={allowExpressways} onChange={onAllowExpresswaysChange} />
            <Switch label="Voice prompts" checked={voiceGuidance} onChange={onVoiceGuidanceChange} />
          </div>
          {allowExpressways ? (
            <p className="tc-route-note">Most expressways in India ban two-wheelers.</p>
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
