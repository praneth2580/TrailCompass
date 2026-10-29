import type { Coordinate } from '../routing/routing-adapter';
import { storageManager } from '../offline/storage-manager';
import type { LocationSource } from '../services/ride-location-plugin';
import type { StoredTrack } from '../services/ride-track';
import { appDatabase } from './database';

/** A recorded ride, as the ride log lists it. Its track is kept in a file. */
export interface RideRecord {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string;
  distanceMeters: number;
  /** Time spent moving (3.6 km/h or more). */
  movingSeconds: number;
  /** Time recording, pauses left out. */
  recordedSeconds: number;
  maxSpeedMps: number;
  climbMeters: number;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  /** Up to 80 points of the track, for the list's thumbnail. */
  preview: Coordinate[];
  /** The GPS mode it was recorded with. */
  source: LocationSource;
  /** The trip it was navigating, if any. */
  routeName?: string;
}

const INDEX_KEY = 'ride-index';

/** Summaries in Preferences (`ride:<id>`); tracks in `map-packages/rides/<id>.json`. */
export class RideRepository {
  async list(): Promise<RideRecord[]> {
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
    const rides: RideRecord[] = [];
    for (const id of ids) {
      const ride = await appDatabase.getJson<RideRecord>(`ride:${id}`);
      if (ride) rides.push(ride);
    }
    return rides.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): Promise<RideRecord | null> {
    return appDatabase.getJson<RideRecord>(`ride:${id}`);
  }

  async save(ride: RideRecord, track?: StoredTrack): Promise<RideRecord> {
    if (track) await storageManager.writeTextFile(trackPath(ride.id), JSON.stringify(track));
    await appDatabase.setJson(`ride:${ride.id}`, ride);
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
    if (!ids.includes(ride.id)) {
      ids.push(ride.id);
      await appDatabase.setJson(INDEX_KEY, ids);
    }
    return ride;
  }

  async getTrack(id: string): Promise<StoredTrack | null> {
    const text = await storageManager.readTextFile(trackPath(id));
    if (!text) return null;
    try {
      return JSON.parse(text) as StoredTrack;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    await appDatabase.remove(`ride:${id}`);
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
    await appDatabase.setJson(
      INDEX_KEY,
      ids.filter((x) => x !== id),
    );
    await storageManager.deleteFile(trackPath(id));
  }
}

function trackPath(id: string): string {
  return `rides/${id}.json`;
}

export const rideRepository = new RideRepository();
