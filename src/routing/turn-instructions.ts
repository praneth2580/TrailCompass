import type { TurnInstruction } from './routing-adapter';

/**
 * Picks the next turn instruction based on remaining distance along the route.
 * Stub logic until a real offline engine supplies structured maneuvers.
 */
export function selectNextInstruction(
  instructions: TurnInstruction[],
  distanceAlongRouteMeters: number,
): TurnInstruction | undefined {
  const next = selectNextInstructionIndex(instructions, distanceAlongRouteMeters);
  return next ? instructions[next.index] : undefined;
}

/**
 * Index of the upcoming instruction and where its maneuver sits along the
 * route. Each instruction's distance is the travel leading up to it, so the
 * running total is the maneuver position.
 */
export function selectNextInstructionIndex(
  instructions: TurnInstruction[],
  distanceAlongRouteMeters: number,
): { index: number; endAlongMeters: number } | undefined {
  if (instructions.length === 0) return undefined;

  let cumulative = 0;
  for (let index = 0; index < instructions.length; index++) {
    cumulative += instructions[index]!.distanceMeters;
    if (distanceAlongRouteMeters < cumulative) {
      return { index, endAlongMeters: cumulative };
    }
  }

  return { index: instructions.length - 1, endAlongMeters: cumulative };
}

export function formatInstructionBanner(
  instruction: TurnInstruction | undefined,
  distanceToManeuverMeters?: number,
): string {
  if (!instruction) {
    return 'No active navigation';
  }

  if (distanceToManeuverMeters != null && Number.isFinite(distanceToManeuverMeters)) {
    return `${formatManeuverDistance(distanceToManeuverMeters)} — ${instruction.text}`;
  }

  return instruction.text;
}

/**
 * Distance to the next turn, rounded so it does not tick over every metre:
 * 10 m steps up close, 50 m steps further out, then tenths of a kilometre.
 */
export function formatManeuverDistance(meters: number): string {
  const distance = Number.isFinite(meters) ? Math.max(0, meters) : 0;
  if (distance < 300) {
    const rounded = Math.round(distance / 10) * 10;
    return rounded === 0 ? 'Now' : `${rounded} m`;
  }
  const fifties = Math.round(distance / 50) * 50;
  if (fifties < 1000) return `${fifties} m`;
  if (distance < 9_950) return `${(distance / 1000).toFixed(1)} km`;
  return `${Math.round(distance / 1000)} km`;
}

export type ManeuverKind =
  | 'straight'
  | 'slight-left'
  | 'slight-right'
  | 'left'
  | 'right'
  | 'sharp-left'
  | 'sharp-right'
  | 'uturn'
  | 'arrive';

/**
 * Which turn arrow to show. The offline engine names its maneuvers
 * ('left', 'sharp right', 'depart' with the turn in the text); other
 * engines use codes, so the instruction text decides when the name does not.
 */
export function maneuverKind(instruction: TurnInstruction): ManeuverKind {
  if (instruction.maneuver === 'arrive') return 'arrive';
  const text = `${instruction.maneuver} ${instruction.text}`.toLowerCase();
  if (/\bu-?turn\b/.test(text)) return 'uturn';
  // "Head toward destination" starts a route; it does not end one.
  if (instruction.maneuver !== 'depart' && /\barriv|\bdestination is\b/.test(text)) {
    return 'arrive';
  }
  // The first side named is this turn's ("Turn right, then left").
  const side = /\b(left|right)\b/.exec(text)?.[1] as 'left' | 'right' | undefined;
  if (!side) return 'straight';
  if (/\bsharp\b/.test(text)) return `sharp-${side}`;
  if (/\b(slight|bear|keep|stay|exit|ramp|merge)\b/.test(text)) return `slight-${side}`;
  return side;
}
