import type { Coordinate, TurnInstruction } from './routing-adapter';
import {
  bearingDegrees,
  haversineMeters,
  turnAngleDegrees,
} from './geo';

const MIN_SEGMENT_M = 12;
const TURN_THRESHOLD_DEG = 35;

function maneuverFromAngle(angle: number): { text: string; maneuver: string } {
  if (Math.abs(angle) < TURN_THRESHOLD_DEG) {
    return { text: 'Continue straight', maneuver: 'straight' };
  }
  if (angle > 120) return { text: 'Make a sharp right', maneuver: 'sharp right' };
  if (angle < -120) return { text: 'Make a sharp left', maneuver: 'sharp left' };
  if (angle > 0) return { text: 'Turn right', maneuver: 'right' };
  return { text: 'Turn left', maneuver: 'left' };
}

/**
 * Derive turn-by-turn instructions from a snapped path polyline.
 */
export function buildManeuversFromPath(
  path: Coordinate[],
): TurnInstruction[] {
  if (path.length < 2) {
    return [{ text: 'Arrive at destination', distanceMeters: 0, maneuver: 'arrive' }];
  }

  const instructions: TurnInstruction[] = [];
  let segmentStart = 0;
  let lastBearing = bearingDegrees(path[0]!, path[1]!);

  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1]!;
    const cur = path[i]!;
    const next = path[i + 1]!;
    const distPrev = haversineMeters(prev, cur);
    if (distPrev < 2) continue;

    const outgoing = bearingDegrees(cur, next);
    const angle = turnAngleDegrees(lastBearing, outgoing);

    if (Math.abs(angle) >= TURN_THRESHOLD_DEG) {
      let distanceMeters = 0;
      for (let j = segmentStart + 1; j <= i; j++) {
        distanceMeters += haversineMeters(path[j - 1]!, path[j]!);
      }
      if (distanceMeters >= MIN_SEGMENT_M || instructions.length === 0) {
        const { text, maneuver } = maneuverFromAngle(angle);
        instructions.push({ text, distanceMeters, maneuver });
        segmentStart = i;
      }
      lastBearing = outgoing;
    } else {
      lastBearing = outgoing;
    }
  }

  let finalDistance = 0;
  for (let j = segmentStart + 1; j < path.length; j++) {
    finalDistance += haversineMeters(path[j - 1]!, path[j]!);
  }
  instructions.push({
    text: 'Arrive at destination',
    distanceMeters: Math.max(finalDistance, 1),
    maneuver: 'arrive',
  });

  if (instructions.length === 1 && path.length >= 2) {
    return [
      {
        text: 'Head toward destination',
        distanceMeters: finalDistance,
        maneuver: 'depart',
      },
      instructions[0]!,
    ];
  }

  // Label the first leg as depart when it was a continue/turn placeholder.
  if (instructions[0] && instructions[0].maneuver !== 'arrive') {
    instructions[0] = {
      ...instructions[0],
      text:
        instructions[0].maneuver === 'straight'
          ? 'Head toward destination'
          : instructions[0].text,
      maneuver: 'depart',
    };
  }

  return instructions;
}
