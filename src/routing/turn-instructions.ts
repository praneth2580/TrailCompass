import type { TurnInstruction } from './routing-adapter';

/**
 * Picks the next turn instruction based on remaining distance along the route.
 * Stub logic until a real offline engine supplies structured maneuvers.
 */
export function selectNextInstruction(
  instructions: TurnInstruction[],
  distanceAlongRouteMeters: number,
): TurnInstruction | undefined {
  if (instructions.length === 0) return undefined;

  let cumulative = 0;
  for (const instruction of instructions) {
    cumulative += instruction.distanceMeters;
    if (distanceAlongRouteMeters < cumulative) {
      return instruction;
    }
  }

  return instructions[instructions.length - 1];
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
