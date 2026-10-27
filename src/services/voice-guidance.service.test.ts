import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnInstruction } from '../routing/routing-adapter';
import type { NavigationState } from '../types/navigation';

const tts = vi.hoisted(() => ({
  speak: vi.fn(async (_options: { text: string }) => undefined),
  stop: vi.fn(async () => undefined),
}));

vi.mock('@capacitor-community/text-to-speech', () => ({
  TextToSpeech: tts,
}));

const { VoiceGuidanceService, spokenDistance } = await import(
  './voice-guidance.service'
);

const turnLeft: TurnInstruction = { text: 'Turn left', distanceMeters: 2_000 };
const arrive: TurnInstruction = {
  text: 'Arrive at destination',
  distanceMeters: 500,
  maneuver: 'arrive',
};

function nav(
  status: NavigationState['status'],
  instruction: TurnInstruction | undefined,
  distance: number | undefined,
  offRoute = false,
): NavigationState {
  return {
    status,
    offRoute,
    currentInstruction: instruction,
    distanceToNextManeuverMeters: distance,
  };
}

function spoken(): string[] {
  return tts.speak.mock.calls.map(([options]) => options.text);
}

beforeEach(() => {
  tts.speak.mockClear();
});

describe('VoiceGuidanceService', () => {
  it('announces the first turn, warns early, then speaks at the turn once', () => {
    const voice = new VoiceGuidanceService();
    voice.update(nav('navigating', turnLeft, 2_000), 0);
    voice.update(nav('navigating', turnLeft, 1_200), 10);
    voice.update(nav('navigating', turnLeft, 290), 10);
    voice.update(nav('navigating', turnLeft, 250), 10);
    voice.update(nav('navigating', turnLeft, 38), 8);
    voice.update(nav('navigating', turnLeft, 20), 8);

    expect(spoken()).toEqual([
      'In 2 kilometres, turn left',
      'In 300 metres, turn left',
      'Turn left',
    ]);
  });

  it('warns earlier at speed', () => {
    const voice = new VoiceGuidanceService();
    voice.update(nav('navigating', turnLeft, 400), 25);

    // 25 m/s × 20 s = 500 m lead, so 400 m is already inside the window.
    expect(spoken()).toEqual(['In 400 metres, turn left']);
  });

  it('says off route once per episode', () => {
    const voice = new VoiceGuidanceService();
    voice.update(nav('navigating', turnLeft, 100, true), 10);
    voice.update(nav('rerouting', turnLeft, 100, true), 10);

    expect(spoken()).toEqual(['Off route. Recalculating']);
  });

  it('skips the "now" prompt for arrival and announces arriving', () => {
    const voice = new VoiceGuidanceService();
    voice.update(nav('navigating', arrive, 30), 5);
    voice.update(nav('arrived', undefined, undefined), 0);

    expect(spoken()).toEqual(['You have arrived']);
  });

  it('stays quiet when turned off', () => {
    const voice = new VoiceGuidanceService();
    voice.setEnabled(false);
    voice.update(nav('navigating', turnLeft, 30), 10);

    expect(spoken()).toEqual([]);
  });
});

describe('spokenDistance', () => {
  it('rounds to what a rider would say', () => {
    expect(spokenDistance(12)).toBe('50 metres');
    expect(spokenDistance(290)).toBe('300 metres');
    expect(spokenDistance(980)).toBe('1 kilometre');
    expect(spokenDistance(1_540)).toBe('1.5 kilometres');
  });
});
