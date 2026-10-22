import type { Coordinate } from '../routing/routing-adapter';
import { appDatabase } from './database';

export interface TripRecord {
  id: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  path: Coordinate[];
  distanceMeters: number;
  notes?: string;
}

const INDEX_KEY = 'trip-index';

export class TripRepository {
  async listTrips(): Promise<TripRecord[]> {
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
    const trips: TripRecord[] = [];
    for (const id of ids) {
      const trip = await appDatabase.getJson<TripRecord>(`trip:${id}`);
      if (trip) trips.push(trip);
    }
    return trips.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async getTrip(id: string): Promise<TripRecord | null> {
    return appDatabase.getJson<TripRecord>(`trip:${id}`);
  }

  async saveTrip(trip: TripRecord): Promise<TripRecord> {
    await appDatabase.setJson(`trip:${trip.id}`, trip);
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
    if (!ids.includes(trip.id)) {
      ids.push(trip.id);
      await appDatabase.setJson(INDEX_KEY, ids);
    }
    return trip;
  }

  async deleteTrip(id: string): Promise<void> {
    await appDatabase.remove(`trip:${id}`);
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
    await appDatabase.setJson(
      INDEX_KEY,
      ids.filter((x) => x !== id),
    );
  }

  createDraft(name = 'Untitled trip'): TripRecord {
    return {
      id: crypto.randomUUID(),
      name,
      startedAt: new Date().toISOString(),
      path: [],
      distanceMeters: 0,
    };
  }
}

export const tripRepository = new TripRepository();
