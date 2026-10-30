import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../routing/routing-adapter';
import { haversineMeters } from '../routing/geo';
import { clusterPlaces, groupRoutes, PathIndex, rideTrip, tripSegments, type RideTrip } from './ride-groups';
import { alongLine, at, DAY, START } from './ride-test-helpers';

/** 5 km due north. */
const straight: Coordinate[] = [at(0, 0), at(0, 5000)];
/** Between the same places, a kilometre east. */
const viaEast: Coordinate[] = [at(0, 0), at(1000, 500), at(1000, 4500), at(0, 5000)];

function trip(id: string, line: Coordinate[], departAt: number, options: Parameters<typeof alongLine>[2] = {}): RideTrip {
  const ridden = rideTrip(id, [alongLine(line, departAt, options)]);
  if (!ridden) throw new Error('no trip');
  return ridden;
}

describe('tripSegments', () => {
  it('leaves out waiting at either end and a tea break on the way', () => {
    const fixes = alongLine([at(0, 0), at(0, 4000)], START, {
      waitStartSeconds: 180,
      waitEndSeconds: 120,
      stops: [{ at: 2000, seconds: 600 }],
    });
    const parts = tripSegments([fixes]);
    // Split at the break.
    expect(parts).toHaveLength(2);
    const ridden = rideTrip('r', [fixes])!;
    // 4 km at 10 m/s, less a fix or two where it's cut.
    expect(ridden.seconds).toBeGreaterThan(380);
    expect(ridden.seconds).toBeLessThanOrEqual(400);
    expect(ridden.departedAt - START).toBeGreaterThanOrEqual(180_000);
    expect(ridden.departedAt - START).toBeLessThan(190_000);
  });

  it('has no trip for a ride that never left', () => {
    const parked = alongLine([at(0, 0), at(0, 20)], START, { waitStartSeconds: 300 });
    expect(rideTrip('parked', [parked])).toBeNull();
  });
});

describe('groupRoutes', () => {
  it('groups rides of the same roads, apart from the other way and another road', () => {
    const groups = groupRoutes([
      trip('a', straight, START),
      // GPS a dozen metres off, and recording started 300 m down the road.
      trip('b', [at(12, 300), at(12, 5000)], START + DAY),
      trip('back', [...straight].reverse(), START + 2 * DAY),
      trip('east', viaEast, START + 3 * DAY),
      trip('e', straight, START + 4 * DAY),
    ]);
    expect(groups.map((group) => group.map((t) => t.id))).toEqual([['a', 'b', 'e'], ['back'], ['east']]);
  });

  it('keeps a loop ridden the other way round apart', () => {
    const loop: Coordinate[] = [at(0, 0), at(0, 2000), at(2000, 2000), at(2000, 0), at(0, 0)];
    const groups = groupRoutes([
      trip('cw', loop, START),
      trip('cw2', loop, START + DAY),
      trip('ccw', [...loop].reverse(), START + 2 * DAY),
    ]);
    expect(groups.map((group) => group.map((t) => t.id))).toEqual([['cw', 'cw2'], ['ccw']]);
  });
});

describe('clusterPlaces', () => {
  it('gathers nearby starts and ends, keeping named places where they are', () => {
    const trips = [
      trip('a', straight, START),
      trip('b', [at(0, 300), at(0, 5000)], START + DAY),
      trip('back', [...straight].reverse(), START + 2 * DAY),
    ];
    const office = at(0, 5100);
    const places = clusterPlaces(trips, [{ id: 'office', coordinate: office }]);
    expect(places).toHaveLength(2);
    const named = places.find((place) => place.id === 'office')!;
    expect(named.center).toEqual(office);
    expect(named.arrivals).toEqual(['a', 'b']);
    expect(named.departures).toEqual(['back']);
    const home = places.find((place) => place.id !== 'office')!;
    expect(home.departures).toEqual(['a', 'b']);
    expect(home.arrivals).toEqual(['back']);
    expect(haversineMeters(home.center, at(0, 100))).toBeLessThan(60);
  });
});

describe('PathIndex', () => {
  it('tells the way there from the way back by where the rider is expected', () => {
    const thereAndBack = new PathIndex([at(0, 0), at(0, 1000), at(8, 1000), at(8, 0)], 50);
    expect(thereAndBack.locate(at(4, 300), 200)!.along).toBeCloseTo(300, -1);
    expect(thereAndBack.locate(at(4, 300), 1600)!.along).toBeCloseTo(1708, -1);
    expect(thereAndBack.locate(at(200, 300))).toBeNull();
  });

  it('cuts out a stretch', () => {
    const path = new PathIndex([at(0, 0), at(0, 1000), at(1000, 1000)]);
    const stretch = path.slice(500, 1500);
    expect(stretch).toHaveLength(3);
    expect(haversineMeters(stretch[0]!, at(0, 500))).toBeLessThan(1);
    expect(haversineMeters(stretch[2]!, at(500, 1000))).toBeLessThan(1);
  });
});
