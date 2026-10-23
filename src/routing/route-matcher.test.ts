import { describe, expect, it } from 'vitest';
import type { Coordinate } from './routing-adapter';
import {
  countPassedWaypoints,
  matchPositionToRoute,
  offRouteThresholdMeters,
  remainingDurationSeconds,
  waypointPositionsAlong,
} from './route-matcher';

const LAT = 48.86;
const METERS_PER_DEG_LAT = 111_195;
const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);

function offset(east: number, north = 0): Coordinate {
  return [2.3 + east / metersPerDegLon, LAT + north / METERS_PER_DEG_LAT];
}

describe('offRouteThresholdMeters', () => {
  it('uses the base threshold without a usable accuracy', () => {
    expect(offRouteThresholdMeters(null)).toBe(50);
    expect(offRouteThresholdMeters(undefined)).toBe(50);
    expect(offRouteThresholdMeters(20)).toBe(50);
  });

  it('widens for poor fixes', () => {
    expect(offRouteThresholdMeters(60)).toBe(90);
  });
});

describe('matchPositionToRoute', () => {
  const longStraight = [offset(0), offset(2000)];

  it('does not flag a rider between far-apart vertices', () => {
    const match = matchPositionToRoute(offset(1000, 8), longStraight);
    expect(match.offRoute).toBe(false);
    expect(match.alongMeters).toBeCloseTo(1000, -1);
  });

  it('flags a rider clearly off the road', () => {
    expect(matchPositionToRoute(offset(1000, 70), longStraight).offRoute).toBe(
      true,
    );
  });

  it('gives a poor fix more slack', () => {
    const match = matchPositionToRoute(offset(1000, 70), longStraight, {
      accuracyMeters: 60,
    });
    expect(match.offRoute).toBe(false);
  });
});

describe('waypointPositionsAlong', () => {
  it('places stops in visit order on an out-and-back road', () => {
    // East 1 km, then back west over the same road.
    const route = [offset(0), offset(1000), offset(0)];
    const [farStop, returnStop] = waypointPositionsAlong(
      [offset(900), offset(100)],
      route,
    );
    expect(farStop).toBeCloseTo(900, -1);
    // Matched on the way back, not on the outbound pass at ~100 m.
    expect(returnStop).toBeCloseTo(1900, -1);
  });
});

describe('countPassedWaypoints', () => {
  it('counts leading stops the rider is at least the margin past', () => {
    expect(countPassedWaypoints([100, 500], 120)).toBe(0);
    expect(countPassedWaypoints([100, 500], 131)).toBe(1);
    expect(countPassedWaypoints([100, 500], 600)).toBe(2);
    expect(countPassedWaypoints([], 600)).toBe(0);
  });
});

describe('remainingDurationSeconds', () => {
  it('scales the planned duration by the remaining share', () => {
    expect(
      remainingDurationSeconds(
        { distanceMeters: 10_000, durationSeconds: 1_000 },
        2_500,
      ),
    ).toBe(250);
  });

  it('falls back to a fixed speed without a planned duration', () => {
    expect(
      remainingDurationSeconds({ distanceMeters: 0, durationSeconds: 0 }, 1_100),
    ).toBe(100);
  });
});
