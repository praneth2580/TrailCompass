import { describe, expect, it } from 'vitest';
import type { TurnInstruction } from './routing-adapter';
import {
  formatManeuverDistance,
  maneuverKind,
  selectNextInstruction,
  selectNextInstructionIndex,
} from './turn-instructions';

describe('selectNextInstructionIndex', () => {
  // Two identical steps: the old text+distance lookup always found the first.
  const instructions: TurnInstruction[] = [
    { text: 'Turn right', distanceMeters: 100, maneuver: 'right' },
    { text: 'Turn right', distanceMeters: 100, maneuver: 'right' },
    { text: 'Arrive at destination', distanceMeters: 50, maneuver: 'arrive' },
  ];

  it('tells identical instructions apart by position', () => {
    const next = selectNextInstructionIndex(instructions, 150)!;
    expect(next.index).toBe(1);
    expect(next.endAlongMeters - 150).toBe(50);
  });

  it('returns the first instruction at the start', () => {
    expect(selectNextInstructionIndex(instructions, 0)).toEqual({
      index: 0,
      endAlongMeters: 100,
    });
  });

  it('stays on the last instruction past the end', () => {
    expect(selectNextInstructionIndex(instructions, 999)?.index).toBe(2);
  });

  it('handles an empty list', () => {
    expect(selectNextInstructionIndex([], 10)).toBeUndefined();
    expect(selectNextInstruction([], 10)).toBeUndefined();
  });
});

describe('formatManeuverDistance', () => {
  it('steps by 10 m up close, so the figure does not tick every metre', () => {
    expect(formatManeuverDistance(143)).toBe('140 m');
    expect(formatManeuverDistance(147)).toBe('150 m');
    expect(formatManeuverDistance(296)).toBe('300 m');
  });

  it('says Now at the turn', () => {
    expect(formatManeuverDistance(3)).toBe('Now');
  });

  it('steps by 50 m further out', () => {
    expect(formatManeuverDistance(312)).toBe('300 m');
    expect(formatManeuverDistance(640)).toBe('650 m');
  });

  it('switches to kilometres', () => {
    expect(formatManeuverDistance(980)).toBe('1.0 km');
    expect(formatManeuverDistance(4_260)).toBe('4.3 km');
    expect(formatManeuverDistance(23_400)).toBe('23 km');
  });
});

describe('maneuverKind', () => {
  const kind = (text: string, maneuver = 'maneuver') =>
    maneuverKind({ text, maneuver, distanceMeters: 100 });

  it("reads the offline engine's maneuvers", () => {
    expect(kind('Turn right', 'right')).toBe('right');
    expect(kind('Make a sharp left', 'sharp left')).toBe('sharp-left');
    expect(kind('Arrive at destination', 'arrive')).toBe('arrive');
  });

  it('takes the first leg\'s turn from its text', () => {
    expect(kind('Turn left', 'depart')).toBe('left');
    expect(kind('Head toward destination', 'depart')).toBe('straight');
  });

  it('reads other engines from the text', () => {
    expect(kind('Bear right onto NH 48.', '9')).toBe('slight-right');
    expect(kind('Keep left at the fork.', '24')).toBe('slight-left');
    expect(kind('Make a U-turn.', '13')).toBe('uturn');
    expect(kind('Your destination is on the right.', '5')).toBe('arrive');
    expect(kind('Continue on SV Road.', '8')).toBe('straight');
  });

  it('uses the first side named', () => {
    expect(kind('Turn right, then turn left')).toBe('right');
  });
});
