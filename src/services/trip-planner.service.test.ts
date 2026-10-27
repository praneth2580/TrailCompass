import { describe, expect, it } from 'vitest';
import { tripPlanner } from './trip-planner.service';

describe('tripPlanner.loadFromSaved', () => {
  it('names the destination and stops from a saved trip', () => {
    tripPlanner.loadFromSaved([73.27, 17.15], [[73.42, 18.08], [73.52, 17.53]], {
      end: 'Ganpatipule',
      endNotes: 'Ratnagiri, Maharashtra',
      stops: [
        { name: 'Mahad', kind: 'manual' },
        { name: 'HP Petrol Pump, Chiplun', kind: 'fuel', notes: '240 km into the trip' },
      ],
    });
    const { destination, stops } = tripPlanner.getState();
    expect(destination).toMatchObject({ name: 'Ganpatipule', notes: 'Ratnagiri, Maharashtra', kind: 'destination' });
    expect(stops.map(({ name, kind, notes }) => ({ name, kind, notes }))).toEqual([
      { name: 'Mahad', kind: 'manual', notes: undefined },
      { name: 'HP Petrol Pump, Chiplun', kind: 'fuel', notes: '240 km into the trip' },
    ]);
  });

  it('falls back to numbered stops for trips saved without names', () => {
    tripPlanner.loadFromSaved([73.27, 17.15], [[73.42, 18.08]]);
    const { destination, stops } = tripPlanner.getState();
    expect(destination?.name).toBe('Destination');
    expect(stops.map((stop) => stop.name)).toEqual(['Stop 1']);
  });
});
