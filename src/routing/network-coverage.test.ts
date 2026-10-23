import { describe, expect, it } from 'vitest';
import type { Coordinate } from './routing-adapter';
import { interpolateGeodesic } from './route-chunking';
import {
  bboxCoversPoints,
  coverageIncludesPoints,
  type NetworkCoverage,
} from './network-coverage';

describe('coverageIncludesPoints', () => {
  // A ~60 km diagonal corridor, sampled the way the OSM loader does it.
  const a: Coordinate = [2.0, 48.5];
  const b: Coordinate = [2.5, 48.9];
  const samples = Array.from({ length: 6 }, (_, i) =>
    interpolateGeodesic(a, b, i / 5),
  );
  const corridor: NetworkCoverage = {
    kind: 'corridor',
    samples,
    radiusMeters: 4_000,
  };
  const bbox: [number, number, number, number] = [1.97, 48.47, 2.53, 48.93];

  it('accepts points along the corridor', () => {
    const onLine = interpolateGeodesic(a, b, 0.42);
    expect(coverageIncludesPoints(corridor, [a, onLine, b])).toBe(true);
  });

  it('rejects a point inside the bbox but far from the corridor', () => {
    // The opposite corner of the bbox: ~20+ km from the diagonal.
    const offCorridor: Coordinate = [2.45, 48.52];
    expect(bboxCoversPoints(bbox, [offCorridor])).toBe(true);
    expect(coverageIncludesPoints(corridor, [offCorridor])).toBe(false);
  });

  it('treats bbox downloads and legacy packs as covering their box', () => {
    expect(coverageIncludesPoints({ kind: 'bbox' }, [[2.45, 48.52]])).toBe(true);
    expect(coverageIncludesPoints(undefined, [[2.45, 48.52]])).toBe(true);
  });
});
