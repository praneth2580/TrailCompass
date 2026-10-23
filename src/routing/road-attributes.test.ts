import { describe, expect, it } from 'vitest';
import {
  controlFromNodeTags,
  isExpressway,
  motorcycleAccess,
  onewayDirection,
  parseMaxspeedMps,
  roadSpeedMps,
} from './road-attributes';
import { MAX_SPEED_MPS, highwaySpeedMps } from './routing-profiles';

describe('motorcycleAccess', () => {
  it('lets a motorcycle tag override general access', () => {
    expect(motorcycleAccess({ access: 'no', motorcycle: 'yes' })).toBe('yes');
    expect(motorcycleAccess({ access: 'yes', motorcycle: 'no' })).toBe('no');
    expect(motorcycleAccess({ motor_vehicle: 'private' })).toBe('no');
    expect(motorcycleAccess({ vehicle: 'destination' })).toBe('destination');
    expect(motorcycleAccess({})).toBe('yes');
  });
});

describe('onewayDirection', () => {
  it('treats roundabouts and motorways as oneway', () => {
    expect(onewayDirection('primary', { junction: 'roundabout' })).toBe(
      'forward',
    );
    expect(onewayDirection('motorway', {})).toBe('forward');
    expect(onewayDirection('residential', {})).toBe('both');
  });

  it('prefers oneway:motorcycle and closes reversible ways', () => {
    expect(
      onewayDirection('residential', {
        oneway: 'yes',
        'oneway:motorcycle': 'no',
      }),
    ).toBe('both');
    expect(onewayDirection('residential', { oneway: '-1' })).toBe('backward');
    expect(onewayDirection('primary', { oneway: 'reversible' })).toBe('closed');
  });
});

describe('isExpressway', () => {
  it('flags motorway-grade roads unless motorcycles are allowed', () => {
    expect(isExpressway('motorway', {})).toBe(true);
    expect(isExpressway('motorway_link', {})).toBe(true);
    expect(isExpressway('trunk', { motorroad: 'yes' })).toBe(true);
    expect(isExpressway('motorway', { motorcycle: 'yes' })).toBe(false);
    expect(isExpressway('trunk', {})).toBe(false);
  });
});

describe('roadSpeedMps', () => {
  it('rides wide roads faster and narrow ones slower', () => {
    const trunk = highwaySpeedMps('trunk');
    expect(roadSpeedMps('trunk', { lanes: '4' })).toBeCloseTo(trunk * 1.05);
    expect(roadSpeedMps('trunk', { lanes: '6' })).toBeCloseTo(trunk * 1.15);
    expect(roadSpeedMps('residential', { lanes: '1' })).toBeCloseTo(
      highwaySpeedMps('residential') * 0.75,
    );
    // One lane on a oneway street is normal, not narrow.
    expect(roadSpeedMps('residential', { lanes: '1', oneway: 'yes' })).toBe(
      highwaySpeedMps('residential'),
    );
  });

  it('applies posted limits and rough surfaces', () => {
    expect(roadSpeedMps('primary', { maxspeed: '30' })).toBeCloseTo(
      (30 / 3.6) * 0.9,
    );
    expect(roadSpeedMps('tertiary', { surface: 'gravel' })).toBeCloseTo(
      highwaySpeedMps('tertiary') * 0.55,
    );
  });

  it('never exceeds MAX_SPEED_MPS (keeps the A* heuristic admissible)', () => {
    expect(
      roadSpeedMps('motorway', { maxspeed: '140', lanes: '8', oneway: 'yes' }),
    ).toBe(MAX_SPEED_MPS);
  });
});

describe('parseMaxspeedMps', () => {
  it('reads numbers and mph, ignores zone codes', () => {
    expect(parseMaxspeedMps('36')).toBeCloseTo(10);
    expect(parseMaxspeedMps('30 mph')).toBeCloseTo((30 * 1.609) / 3.6);
    expect(parseMaxspeedMps('IN:urban')).toBeNull();
    expect(parseMaxspeedMps('none')).toBeNull();
  });
});

describe('controlFromNodeTags', () => {
  it('reads signals with direction and ignores plain nodes', () => {
    expect(
      controlFromNodeTags([1, 2], {
        highway: 'traffic_signals',
        'traffic_signals:direction': 'forward',
      }),
    ).toEqual({ coordinate: [1, 2], kind: 'traffic_signals', direction: 'forward' });
    expect(controlFromNodeTags([1, 2], { railway: 'level_crossing' })).toEqual({
      coordinate: [1, 2],
      kind: 'level_crossing',
    });
    expect(controlFromNodeTags([1, 2], { highway: 'crossing' })).toBeNull();
  });
});
