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
    const rounded =
      distanceToManeuverMeters >= 1000
        ? `${(distanceToManeuverMeters / 1000).toFixed(1)} km`
        : `${Math.round(distanceToManeuverMeters)} m`;
    return `${rounded} — ${instruction.text}`;
  }

  return instruction.text;
}
