import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../routing/routing-adapter';
import { rideTrip } from './ride-groups';
import { analyzeRoute, compareByPeriod, trafficLevel, trafficLines, type RouteStretch } from './ride-insights';
import { alongLine, at, DAY, START } from './ride-test-helpers';
import { summarizeTrack } from './ride-track';

/** 5 km due north. */
const road: Coordinate[] = [at(0, 0), at(0, 5000)];
const KMH_40 = 40 / 3.6;
const KMH_8 = 8 / 3.6;
/** Crawling from 2.0 to 2.6 km. */
const jam = (along: number) => (along >= 2000 && along < 2600 ? KMH_8 : KMH_40);

describe('analyzeRoute', () => {
  const rides = [
    { id: 'mon', segments: [alongLine(road, START, { speed: jam })] },
    { id: 'tue', segments: [alongLine(road, START + DAY, { speed: jam })] },
    { id: 'sun', segments: [alongLine(road, START + 6 * DAY + 2 * 3_600_000, { speed: () => KMH_40 })] },
  ];
  const analysis = analyzeRoute(rideTrip('mon', rides[0]!.segments)!.path, rides);

  it('times the route ride by ride', () => {
    expect(analysis.rides.map((ride) => ride.id)).toEqual(['sun', 'tue', 'mon']);
    // 4.4 km at 40 km/h and 600 m at 8 km/h: 396 s + 270 s.
    expect(analysis.typicalSeconds).toBeGreaterThan(650);
    expect(analysis.typicalSeconds).toBeLessThan(680);
    expect(analysis.bestSeconds).toBeGreaterThan(440);
    expect(analysis.bestSeconds).toBeLessThan(460);
    expect(analysis.slowestSeconds).toBe(Math.max(...analysis.rides.map((ride) => ride.seconds)));
  });

  it('finds where traffic usually slows you', () => {
    expect(analysis.slowSpots).toHaveLength(1);
    const [spot] = analysis.slowSpots;
    expect(spot!.from).toBeGreaterThan(1850);
    expect(spot!.from).toBeLessThan(2100);
    expect(spot!.to).toBeGreaterThan(2500);
    expect(spot!.to).toBeLessThan(2750);
    expect(spot!.speedKmh).toBeLessThan(12);
    expect(spot!.rides).toBe(3);
    // About 270 s usually, against about 54 s at 40 km/h.
    expect(spot!.lostSeconds).toBeGreaterThan(180);
    expect(spot!.bestSeconds).toBeLessThan(spot!.typicalSeconds);
  });

  it('colours the open road clear and the crawl jammed', () => {
    const levelAt = (along: number) => analysis.stretches.find((s) => s.from <= along && along < s.to)!.level;
    expect(levelAt(1000)).toBe('clear');
    expect(levelAt(2300)).toBe('jammed');
    expect(levelAt(4000)).toBe('clear');
  });

  it('compares by the hour the rides set off', () => {
    const hour = new Date(START).getHours();
    const later = new Date(START + 2 * 3_600_000).getHours();
    expect(analysis.byHour.map(({ hour: h, rides: n }) => [h, n])).toEqual(
      [
        [hour, 2],
        [later, 1],
      ].sort((a, b) => a[0]! - b[0]!),
    );
    const morning = analysis.byHour.find((entry) => entry.hour === hour)!;
    expect(morning.typicalSeconds).toBeGreaterThan(650);
  });
});

describe('a stop at the lights', () => {
  it('survives keeping the track, and shows where it was', () => {
    // One fix a second, 40 km/h, a 90 s red light at 1.5 km.
    const recorded = (startAt: number) =>
      summarizeTrack([alongLine([at(0, 0), at(0, 3000)], startAt, { speed: () => KMH_40, every: 1, stops: [{ at: 1500, seconds: 90 }] })])
        .segments;
    const rides = [
      { id: 'a', segments: recorded(START) },
      { id: 'b', segments: recorded(START + DAY) },
    ];
    // A straight road: without timing, the track would keep only its two ends.
    expect(rides[0]!.segments[0]!.length).toBeGreaterThan(2);
    const analysis = analyzeRoute(rideTrip('a', rides[0]!.segments)!.path, rides);
    const [spot] = analysis.slowSpots;
    expect(spot).toBeDefined();
    // The rider stood at the first fix past 1.5 km, 1511 m in.
    expect(spot!.from).toBeLessThan(1511);
    expect(spot!.to).toBeGreaterThan(1511);
    expect(spot!.typicalSeconds).toBeGreaterThan(90);
  });
});

describe('trafficLines', () => {
  it('joins neighbouring stretches of the same traffic', () => {
    const stretch = (from: number, level: RouteStretch['level']): RouteStretch => ({
      from,
      to: from + 100,
      rides: 1,
      typicalSeconds: 10,
      bestSeconds: 10,
      speedKmh: 36,
      level,
    });
    const lines = trafficLines(
      [at(0, 0), at(0, 400)],
      [stretch(0, 'clear'), stretch(100, 'clear'), stretch(200, 'slow'), stretch(300, null)],
    );
    expect(lines.map((line) => line.level)).toEqual(['clear', 'slow', null]);
  });
});

describe('compareByPeriod', () => {
  const morning = new Date(2026, 9, 27, 8, 30).getTime();
  const afternoon = new Date(2026, 9, 27, 14, 0).getTime();
  const evening = new Date(2026, 9, 27, 18, 30).getTime();

  it('sets ways side by side only at the same time of day', () => {
    const compared = compareByPeriod([
      // Quickest overall, thanks to quiet afternoons; slower than the coast road in the rush.
      {
        way: 'highway',
        trips: [
          { departedAt: morning, seconds: 1200 },
          { departedAt: afternoon, seconds: 400 },
          { departedAt: afternoon, seconds: 420 },
        ],
      },
      {
        way: 'coast',
        trips: [
          { departedAt: morning + 600_000, seconds: 900 },
          { departedAt: evening, seconds: 800 },
        ],
      },
    ]);
    // Only mornings have both ways.
    expect(compared).toEqual([
      {
        period: 'morning',
        ways: [
          { way: 'coast', typicalSeconds: 900, rides: 1 },
          { way: 'highway', typicalSeconds: 1200, rides: 1 },
        ],
      },
    ]);
  });
});

describe('trafficLevel', () => {
  it('reads speed as traffic', () => {
    expect(trafficLevel(50)).toBe('clear');
    expect(trafficLevel(25)).toBe('moderate');
    expect(trafficLevel(12)).toBe('slow');
    expect(trafficLevel(4)).toBe('jammed');
  });
});
