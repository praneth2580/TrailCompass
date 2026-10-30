import { describe, expect, it } from 'vitest';
import {
  decodeTrack,
  DistanceCounter,
  encodeTrack,
  parseRawTrack,
  rawLine,
  rideName,
  simplify,
  summarizeTrack,
  toGpx,
  type TrackFix,
} from './ride-track';

const START = Date.UTC(2026, 9, 29, 2, 0, 0);
/** About 11.1 m per 0.0001° of latitude. */
const LAT_STEP = 0.0001;

/** A ride north at `mps`, one fix a second. */
function ride(seconds: number, mps: number, from = { lat: 19.0, t: START }, extra: Partial<TrackFix> = {}): TrackFix[] {
  return Array.from({ length: seconds + 1 }, (_, i) => ({
    t: from.t + i * 1000,
    lat: from.lat + (i * mps) / 110_574,
    lon: 72.8,
    acc: 5,
    speed: mps,
    ...extra,
  }));
}

describe('parseRawTrack', () => {
  it('reads fixes and splits at pauses', () => {
    const text = [
      `${START},19.0000000,72.8000000,5.0,12.0,10.00,90,9`,
      `${START + 1000},19.0001000,72.8000000,,,,,0`,
      `#pause,${START + 2000}`,
      `#resume,${START + 60000}`,
      `${START + 61000},19.0100000,72.8000000,4.0,,,,`,
      'garbage,line',
      `#end,${START + 62000}`,
      '',
    ].join('\n');
    const segments = parseRawTrack(text);
    expect(segments).toHaveLength(2);
    expect(segments[0]![0]).toEqual({ t: START, lat: 19, lon: 72.8, acc: 5, alt: 12, speed: 10 });
    expect(segments[0]![1]).toEqual({ t: START + 1000, lat: 19.0001, lon: 72.8 });
    expect(segments[1]).toHaveLength(1);
  });

  it('reads back what rawLine writes', () => {
    const fix = { t: START, lat: 19.0728, lon: 72.8826, acc: 4.5, alt: 11, speed: 12.25 };
    expect(parseRawTrack(rawLine(fix))).toEqual([[fix]]);
  });
});

describe('DistanceCounter', () => {
  it('ignores GPS drift while parked and imprecise fixes', () => {
    const counter = new DistanceCounter();
    counter.add({ t: START, lat: 19, lon: 72.8, acc: 8 });
    // Wobbling by about 4 m for ten minutes.
    for (let i = 1; i < 600; i++) {
      counter.add({ t: START + i * 1000, lat: 19 + (i % 2) * 0.00004, lon: 72.8, acc: 8 });
    }
    // A wild fix 300 m away, but ±80 m.
    counter.add({ t: START + 601_000, lat: 19.0027, lon: 72.8, acc: 80 });
    expect(counter.distanceMeters).toBe(0);
  });
});

describe('summarizeTrack', () => {
  it('measures distance, moving time and speed of a ride with a stop', () => {
    const first = ride(600, 10); // 10 minutes at 36 km/h: 6 km
    const end = first[first.length - 1]!;
    // Stopped for 5 minutes, drifting.
    const stop = Array.from({ length: 300 }, (_, i) => ({ ...end, t: end.t + (i + 1) * 1000, lat: end.lat + (i % 2) * 0.00002, speed: 0 }));
    const second = ride(300, 20, { lat: end.lat, t: end.t + 301_000 }).slice(1); // 5 minutes at 72 km/h: 6 km
    const summary = summarizeTrack([[...first, ...stop, ...second]]);
    expect(summary.distanceMeters).toBeGreaterThan(11_900);
    expect(summary.distanceMeters).toBeLessThan(12_100);
    expect(summary.movingSeconds).toBeGreaterThan(890);
    expect(summary.movingSeconds).toBeLessThan(920);
    expect(summary.maxSpeedMps).toBeCloseTo(20, 5);
    // A straight line keeps only its ends.
    expect(summary.segments[0]!.length).toBeLessThan(10);
  });

  it('does not join the stretches either side of a pause', () => {
    const before = ride(60, 10);
    // Resumed 5 km further north (the rider was carried, or paused by mistake).
    const after = ride(60, 10, { lat: 19.05, t: START + 3_600_000 });
    const summary = summarizeTrack([before, after]);
    expect(summary.segments).toHaveLength(2);
    expect(summary.distanceMeters).toBeGreaterThan(1_150);
    expect(summary.distanceMeters).toBeLessThan(1_250);
  });

  it('ignores a single speed glitch and counts climbs over GPS noise', () => {
    const fixes = ride(120, 12).map((fix, i) => ({
      ...fix,
      speed: i === 50 ? 95 : fix.speed,
      // Climbing 60 m, with ±3 m noise.
      alt: 100 + i * 0.5 + (i % 3) - 1,
    }));
    const summary = summarizeTrack([fixes]);
    expect(summary.maxSpeedMps).toBeCloseTo(12, 5);
    expect(summary.climbMeters).toBeGreaterThanOrEqual(50);
    expect(summary.climbMeters).toBeLessThanOrEqual(62);
  });

  it('works out speed from positions when the GPS reports none', () => {
    const fixes = ride(60, 15).map(({ speed: _speed, ...fix }) => fix);
    expect(summarizeTrack([fixes]).maxSpeedMps).toBeCloseTo(15, 0);
  });

  it('has nothing to show for a ride with no usable fixes', () => {
    const summary = summarizeTrack([[{ t: START, lat: 19, lon: 72.8, acc: 500 }]]);
    expect(summary.segments).toEqual([]);
    expect(summary.bbox).toBeNull();
    expect(summary.distanceMeters).toBe(0);
  });
});

describe('simplify', () => {
  it('keeps the corners of an L-shaped ride', () => {
    const north = Array.from({ length: 50 }, (_, i) => ({ t: START + i, lat: 19 + i * LAT_STEP, lon: 72.8 }));
    const east = Array.from({ length: 50 }, (_, i) => ({ t: START + 50 + i, lat: 19 + 49 * LAT_STEP, lon: 72.8 + (i + 1) * LAT_STEP }));
    const kept = simplify([...north, ...east], 3);
    expect(kept.map((p) => [p.lat, p.lon])).toEqual([
      [19, 72.8],
      [19 + 49 * LAT_STEP, 72.8],
      [19 + 49 * LAT_STEP, 72.8 + 50 * LAT_STEP],
    ]);
  });

  it('keeps a stop on a straight road when timing counts', () => {
    const before = ride(100, 10);
    const stopped = before[before.length - 1]!;
    const after = ride(100, 10, { lat: stopped.lat, t: stopped.t + 60_000 });
    // Standing a minute: the same spot, a minute apart.
    const points = [...before, ...after];
    expect(simplify(points, 3)).toHaveLength(2);
    const kept = simplify(points, 3, 25);
    expect(kept.map((p) => p.t)).toContain(stopped.t);
    expect(kept.map((p) => p.t)).toContain(stopped.t + 60_000);
    expect(kept.length).toBeLessThan(6);
  });
});

describe('stored tracks', () => {
  it('round-trips positions to about a metre, with times and heights', () => {
    const segments = [
      [
        { t: START, lat: 19.07281, lon: 72.88262, alt: 12 },
        { t: START + 7000, lat: 19.07, lon: 72.88, alt: 9 },
      ],
      [{ t: START + 3_600_000, lat: 18.52, lon: 73.85, alt: 560 }],
    ];
    const decoded = decodeTrack(JSON.parse(JSON.stringify(encodeTrack(segments, START))), START);
    expect(decoded).toEqual(segments);
  });

  it('leaves heights out when some fixes have none', () => {
    const segments = [[{ t: START, lat: 19, lon: 72.8, alt: 3 }, { t: START + 1000, lat: 19.001, lon: 72.8 }]];
    const stored = encodeTrack(segments, START);
    expect(stored.segments[0]!.ele).toBeUndefined();
    expect(decodeTrack(stored, START)[0]![1]).toEqual({ t: START + 1000, lat: 19.001, lon: 72.8 });
  });
});

describe('toGpx', () => {
  it('writes a track segment per stretch, with escaped names', () => {
    const gpx = toGpx('Ghats & back', [[{ t: START, lat: 19, lon: 72.8, alt: 10 }], [{ t: START + 5000, lat: 19.1, lon: 72.9 }]]);
    expect(gpx).toContain('<name>Ghats &amp; back</name>');
    expect(gpx.match(/<trkseg>/g)).toHaveLength(2);
    expect(gpx).toContain('<trkpt lat="19.000000" lon="72.800000"><ele>10</ele><time>2026-10-29T02:00:00.000Z</time></trkpt>');
  });
});

describe('rideName', () => {
  it('names a ride by the time it started', () => {
    expect(rideName(new Date(2026, 9, 29, 6, 30))).toBe('Morning ride');
    expect(rideName(new Date(2026, 9, 29, 14, 0))).toBe('Afternoon ride');
    expect(rideName(new Date(2026, 9, 29, 19, 0))).toBe('Evening ride');
    expect(rideName(new Date(2026, 9, 29, 23, 0))).toBe('Night ride');
  });
});
