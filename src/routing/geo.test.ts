import { describe, expect, it } from 'vitest';
import type { Coordinate } from './routing-adapter';
import {
  distanceAlongPolylineMeters,
  haversineMeters,
  polylineLengthMeters,
  projectOntoPolyline,
  remainingFromProjectionMeters,
  samplePolylineMeters,
} from './geo';

const LAT = 48.86;
const METERS_PER_DEG_LAT = 111_195;
const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);

/** Point `east` / `north` meters from [2.3, LAT]. */
function offset(east: number, north = 0): Coordinate {
  return [2.3 + east / metersPerDegLon, LAT + north / METERS_PER_DEG_LAT];
}

describe('projectOntoPolyline', () => {
  const segment = [offset(0), offset(1000)];

  it('measures to the segment, not the nearest vertex', () => {
    const rider = offset(500, 10);
    const projection = projectOntoPolyline(rider, segment)!;

    expect(projection.distanceToRouteMeters).toBeCloseTo(10, 0);
    expect(projection.alongMeters).toBeCloseTo(500, -1);
    expect(projection.segmentIndex).toBe(0);
    // The old vertex-only match put this rider ~500 m from the route.
    expect(haversineMeters(rider, segment[0]!)).toBeGreaterThan(490);
  });

  it('picks the closest of several segments and accumulates along distance', () => {
    const route = [offset(0), offset(1000), offset(1000, 1000)];
    const projection = projectOntoPolyline(offset(1010, 400), route)!;

    expect(projection.segmentIndex).toBe(1);
    expect(projection.distanceToRouteMeters).toBeCloseTo(10, 0);
    expect(projection.alongMeters).toBeCloseTo(1400, -1);
  });

  it('clamps to the end vertices', () => {
    const projection = projectOntoPolyline(offset(-200), segment)!;
    expect(projection.t).toBe(0);
    expect(projection.alongMeters).toBe(0);
    expect(projection.distanceToRouteMeters).toBeCloseTo(200, -1);
  });

  it('handles empty and single-point routes', () => {
    expect(projectOntoPolyline(offset(0), [])).toBeNull();
    const single = projectOntoPolyline(offset(30), [offset(0)])!;
    expect(single.alongMeters).toBe(0);
    expect(single.distanceToRouteMeters).toBeCloseTo(30, 0);
  });
});

describe('distanceAlongPolylineMeters', () => {
  it('keeps its return shape on top of the projection', () => {
    const result = distanceAlongPolylineMeters(offset(250, 5), [
      offset(0),
      offset(1000),
    ]);
    expect(result.nearestIndex).toBe(0);
    expect(result.alongMeters).toBeCloseTo(250, -1);
    expect(result.distanceToRouteMeters).toBeCloseTo(5, 0);
  });
});

describe('remainingFromProjectionMeters', () => {
  it('counts the rest of the current segment plus later segments', () => {
    const route = [offset(0), offset(1000), offset(1000, 1000)];
    const projection = projectOntoPolyline(offset(300), route)!;
    expect(remainingFromProjectionMeters(route, projection)).toBeCloseTo(
      1700,
      -1,
    );
  });
});

describe('samplePolylineMeters', () => {
  // About 106 km along the 18°N parallel.
  const line: Coordinate[] = [
    [73, 18],
    [74, 18],
  ];

  it('samples every step between the bounds, both ends included', () => {
    const samples = samplePolylineMeters(line, 10_000, 40_000, 10_000);
    expect(samples.map((s) => Math.round(s.alongMeters))).toEqual([
      10_000, 20_000, 30_000, 40_000,
    ]);
    expect(samples[1]!.coordinate[0]).toBeCloseTo(73 + 20_000 / polylineLengthMeters(line), 6);
  });

  it('clamps the bounds to the route', () => {
    const total = polylineLengthMeters(line);
    const samples = samplePolylineMeters(line, -5_000, total + 5_000, 50_000);
    expect(samples[0]!.alongMeters).toBe(0);
    expect(samples[samples.length - 1]!.alongMeters).toBeCloseTo(total, 3);
    expect(samples[samples.length - 1]!.coordinate).toEqual([74, 18]);
  });
});
