import type { CalculatedRoute, Coordinate } from './routing-adapter';

/**
 * Join consecutive route legs into one route. A leg that starts exactly
 * where the previous one ended has its duplicate first point dropped.
 */
export function mergeRoutes(legs: CalculatedRoute[]): CalculatedRoute {
  if (legs.length === 0) {
    throw new Error('No route legs to merge');
  }
  if (legs.length === 1) return legs[0]!;

  const coordinates: Coordinate[] = [...legs[0]!.coordinates];
  const instructions = [...legs[0]!.instructions];
  let distanceMeters = legs[0]!.distanceMeters;
  let durationSeconds = legs[0]!.durationSeconds;

  for (let i = 1; i < legs.length; i++) {
    const leg = legs[i]!;
    const slice =
      coordinates.length > 0 &&
      leg.coordinates[0] &&
      coordinates[coordinates.length - 1]![0] === leg.coordinates[0][0] &&
      coordinates[coordinates.length - 1]![1] === leg.coordinates[0][1]
        ? leg.coordinates.slice(1)
        : leg.coordinates;
    coordinates.push(...slice);
    instructions.push(...leg.instructions);
    distanceMeters += leg.distanceMeters;
    durationSeconds += leg.durationSeconds;
  }

  return { coordinates, distanceMeters, durationSeconds, instructions };
}
