import { describe, expect, it } from 'vitest';
import type { NetworkFeatureCollection } from '../routing/graph-engine';
import { mainRoadNames } from './road-pack.service';

function roads(...ways: Array<[name: string | null, highway: string]>): NetworkFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: ways.map(([name, highway]) => ({
      type: 'Feature',
      properties: { name, highway },
      geometry: { type: 'LineString', coordinates: [[73, 18], [73.01, 18.01]] },
    })),
  };
}

describe('mainRoadNames', () => {
  it('names a pack by its main roads, bigger roads first', () => {
    const pack = roads(
      ['Station Road', 'residential'],
      ['Station Road', 'residential'],
      ['Station Road', 'residential'],
      ['Mumbai–Pune Expressway', 'motorway'],
      ['Sion–Panvel Highway', 'trunk_link'],
      [null, 'trunk'],
    );
    expect(mainRoadNames(pack)).toEqual(['Mumbai–Pune Expressway', 'Sion–Panvel Highway']);
  });

  it('has no names for roads without any', () => {
    expect(mainRoadNames(roads([null, 'primary'], ['  ', 'tertiary']))).toEqual([]);
  });
});
