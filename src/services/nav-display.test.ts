import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../routing/routing-adapter';
import {
  interpolateAngle,
  lineProgressAt,
  mercatorCumulativeLengths,
  navigationZoomForSpeed,
  riderHeadingDegrees,
} from './nav-display';

describe('riderHeadingDegrees', () => {
  it('follows the road while on the route', () => {
    expect(
      riderHeadingDegrees({ courseDegrees: 97, speedMps: 12, routeBearingDegrees: 90 }),
    ).toBe(90);
  });

  it('keeps pointing along the road when stopped', () => {
    expect(
      riderHeadingDegrees({ courseDegrees: null, speedMps: 0, routeBearingDegrees: 90 }),
    ).toBe(90);
  });

  it('trusts the course when riding against the route', () => {
    expect(
      riderHeadingDegrees({ courseDegrees: 268, speedMps: 12, routeBearingDegrees: 90 }),
    ).toBe(268);
  });

  it('uses the course off the route, but only while moving', () => {
    expect(riderHeadingDegrees({ courseDegrees: 45, speedMps: 8 })).toBe(45);
    // At a standstill the course is noise: keep the last heading.
    expect(riderHeadingDegrees({ courseDegrees: 45, speedMps: 0.4 })).toBeNull();
    expect(riderHeadingDegrees({ courseDegrees: null, speedMps: 8 })).toBeNull();
  });
});

describe('navigationZoomForSpeed', () => {
  it('stays close in at low speed', () => {
    expect(navigationZoomForSpeed(0)).toBe(17);
    expect(navigationZoomForSpeed(null)).toBe(17);
  });

  it('zooms out as speed rises', () => {
    const city = navigationZoomForSpeed(40 / 3.6);
    const highway = navigationZoomForSpeed(90 / 3.6);
    expect(city).toBeLessThan(17);
    expect(highway).toBeLessThan(city);
    expect(navigationZoomForSpeed(150 / 3.6)).toBe(15);
  });
});

describe('interpolateAngle', () => {
  it('turns the short way across north', () => {
    expect(interpolateAngle(350, 10, 0.5)).toBeCloseTo(0, 6);
    expect(interpolateAngle(10, 350, 0.25)).toBeCloseTo(5, 6);
  });
});

describe('lineProgressAt', () => {
  it('measures the share of the route behind the rider', () => {
    const route: Coordinate[] = [
      [72.8, 19.0],
      [72.8, 19.1],
      [72.8, 19.2],
    ];
    const cumulative = mercatorCumulativeLengths(route);
    expect(lineProgressAt(route, cumulative, { segmentIndex: 0, point: route[0]! })).toBe(0);
    expect(
      lineProgressAt(route, cumulative, { segmentIndex: 1, point: route[1]! }),
    ).toBeCloseTo(0.5, 2);
    expect(lineProgressAt(route, cumulative, { segmentIndex: 1, point: route[2]! })).toBe(1);
  });

  it('weighs a long north–south route the way the map draws it', () => {
    // Mumbai to Delhi: Mercator stretches the north, so the midpoint by
    // latitude is short of half the drawn line.
    const route: Coordinate[] = [
      [77, 19],
      [77, 23.5],
      [77, 28],
    ];
    const progress = lineProgressAt(route, mercatorCumulativeLengths(route), {
      segmentIndex: 1,
      point: route[1]!,
    });
    const y = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    expect(progress).toBeCloseTo((y(23.5) - y(19)) / (y(28) - y(19)), 6);
    expect(progress).toBeLessThan(0.5);
  });
});
