import type { Coordinate } from '../routing/routing-adapter';
import { pointAlongPolylineMeters, polylineLengthMeters } from '../routing/geo';
import type { TrackFix } from './ride-track';

/** Made-up rides near Mumbai, for the ride log's tests. */

export const START = Date.UTC(2026, 9, 27, 3, 0, 0);
export const DAY = 24 * 3_600_000;
const M_PER_DEG = (Math.PI / 180) * 6_371_000;
const KX = M_PER_DEG * Math.cos((19 * Math.PI) / 180);

/** The point `east` and `north` metres from 19° N, 72.8° E. */
export function at(east: number, north: number): Coordinate {
  return [72.8 + east / KX, 19 + north / M_PER_DEG];
}

export interface RideOptions {
  /** Speed (m/s) at a position along the line; 10 m/s if not given. */
  speed?: (along: number) => number;
  /** Seconds between fixes. */
  every?: number;
  waitStartSeconds?: number;
  waitEndSeconds?: number;
  /** Standing still at positions along the line. */
  stops?: Array<{ at: number; seconds: number }>;
}

/** A fix every few seconds along `line`, from `startAt`. Standing still wobbles a few metres. */
export function alongLine(line: Coordinate[], startAt: number, options: RideOptions = {}): TrackFix[] {
  const { speed = () => 10, every = 2, waitStartSeconds = 0, waitEndSeconds = 0, stops = [] } = options;
  const length = polylineLengthMeters(line);
  const fixes: TrackFix[] = [];
  let t = startAt;
  const push = (along: number, wobble = 0) => {
    const [lon, lat] = pointAlongPolylineMeters(line, along)!.coordinate;
    const offset = wobble ? (((fixes.length % 3) - 1) * wobble) / M_PER_DEG : 0;
    fixes.push({ t, lat: lat + offset, lon, acc: 5 });
  };
  const wait = (along: number, seconds: number) => {
    for (const end = t + seconds * 1000; t < end; t += every * 1000) push(along, 4);
  };

  wait(0, waitStartSeconds);
  const pending = [...stops].sort((a, b) => a.at - b.at);
  let along = 0;
  for (;;) {
    push(along);
    if (along >= length) break;
    if (pending[0] && along >= pending[0].at) {
      t += every * 1000;
      wait(along, pending.shift()!.seconds);
      continue;
    }
    along = Math.min(length, along + speed(along) * every);
    t += every * 1000;
  }
  t += every * 1000;
  wait(length, waitEndSeconds);
  return fixes;
}
