import { describe, expect, it } from 'vitest';
import type { TurnInstruction } from './routing-adapter';
import {
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
