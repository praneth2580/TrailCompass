import { TextToSpeech } from '@capacitor-community/text-to-speech';
import type { TurnInstruction } from '../routing/routing-adapter';
import type { NavigationState, NavigationStatus } from '../types/navigation';

const PREFS_VOICE_GUIDANCE = 'tc.voiceGuidance';

/** Early prompt: about this many seconds ahead, never closer than EARLY_MIN_M. */
const EARLY_LEAD_S = 20;
const EARLY_MIN_M = 300;
/** "Turn now" prompt: about this many seconds ahead, never closer than NOW_MIN_M. */
const NOW_LEAD_S = 4;
const NOW_MIN_M = 40;

/** Voice prompts are on unless the rider turned them off. */
export function loadVoiceGuidance(): boolean {
  try {
    return localStorage.getItem(PREFS_VOICE_GUIDANCE) !== '0';
  } catch {
    return true;
  }
}

export function saveVoiceGuidance(enabled: boolean): void {
  try {
    localStorage.setItem(PREFS_VOICE_GUIDANCE, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

/**
 * Spoken turn prompts for a rider on a helmet headset: one early warning
 * and one at the turn, scaled to speed, plus off-route and arrival.
 * Fed with each NavigationState and the latest GPS speed.
 */
export class VoiceGuidanceService {
  private enabled = loadVoiceGuidance();
  private status: NavigationStatus = 'idle';
  /** Instructions are stable objects per route, so identity marks a new step. */
  private instruction: TurnInstruction | null = null;
  private spokeEarly = false;
  private spokeNow = false;
  private wasOffRoute = false;

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    saveVoiceGuidance(enabled);
    if (!enabled) void TextToSpeech.stop().catch(() => undefined);
  }

  update(state: NavigationState, speedMps: number | null): void {
    const wasActive = isActive(this.status);
    this.status = state.status;

    if (!isActive(state.status)) {
      if (wasActive && state.status === 'arrived') this.say('You have arrived');
      if (wasActive) this.reset();
      return;
    }

    if (state.offRoute && !this.wasOffRoute) {
      this.say('Off route. Recalculating');
    }
    this.wasOffRoute = state.offRoute;
    if (state.offRoute) return;

    const next = state.currentInstruction;
    const distance = state.distanceToNextManeuverMeters;
    if (!next || distance == null || !Number.isFinite(distance)) return;

    const speed = Math.max(0, speedMps ?? 0);
    const nowAt = Math.max(NOW_MIN_M, speed * NOW_LEAD_S);
    const earlyAt = Math.max(EARLY_MIN_M, speed * EARLY_LEAD_S);

    if (next !== this.instruction) {
      const starting = this.instruction == null;
      this.instruction = next;
      this.spokeEarly = false;
      this.spokeNow = false;
      if (starting && distance > earlyAt) {
        this.say(`In ${spokenDistance(distance)}, ${lowerFirst(next.text)}`);
        return;
      }
    }

    if (!this.spokeNow && distance <= nowAt) {
      this.spokeNow = true;
      this.spokeEarly = true;
      // "Arrive at destination" is followed by "You have arrived".
      if (next.maneuver !== 'arrive') this.say(next.text);
      return;
    }

    if (!this.spokeEarly && distance <= earlyAt) {
      this.spokeEarly = true;
      this.say(`In ${spokenDistance(distance)}, ${lowerFirst(next.text)}`);
    }
  }

  private reset(): void {
    this.instruction = null;
    this.spokeEarly = false;
    this.spokeNow = false;
    this.wasOffRoute = false;
  }

  private say(text: string): void {
    if (!this.enabled) return;
    // The default queue strategy replaces a prompt that is still playing.
    void TextToSpeech.speak({ text, lang: 'en-US' }).catch(() => {
      // No speech engine available — the banner still shows the turn.
    });
  }
}

function isActive(status: NavigationStatus): boolean {
  return status === 'navigating' || status === 'rerouting';
}

/** "300 metres", "1.5 kilometres" — rounded the way a rider would say it. */
export function spokenDistance(meters: number): string {
  const rounded = Math.max(50, Math.round(meters / 50) * 50);
  if (rounded < 1000) return `${rounded} metres`;
  const km = Math.round(meters / 100) / 10;
  return `${km} kilometre${km === 1 ? '' : 's'}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export const voiceGuidance = new VoiceGuidanceService();
