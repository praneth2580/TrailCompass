import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { rideRepository, type RideRecord } from '../database/ride-repository';
import { routeRepository } from '../database/route-repository';
import { storageManager } from '../offline/storage-manager';
import type { Coordinate } from '../routing/routing-adapter';
import type { GpsFix, NavigationState } from '../types/navigation';
import type { SavedRoute } from '../types/route';
import { Downloads } from './downloads-plugin';
import { locationService } from './location.service';
import { mapService } from './map.service';
import { navigationService } from './navigation.service';
import { RideLocation, type NativeRecording } from './ride-location-plugin';
import {
  decodeTrack,
  DistanceCounter,
  encodeTrack,
  parseRawTrack,
  previewLine,
  rawLine,
  rideName,
  summarizeTrack,
  toGpx,
  type TrackFix,
} from './ride-track';
import { shareFile } from './share-file';
import { tripPlanner } from './trip-planner.service';

/**
 * The ride log: records rides and keeps them. On Android a foreground
 * service records (RideRecorderService.java), so a ride carries on with
 * the screen off or the app closed; in a browser the page records while
 * it is open. Either way the raw track goes to `rides/<id>.csv`, and
 * finishing turns it into a ride (ride-track.ts) kept by rideRepository.
 *
 * With the setting on, navigating records a ride, and arriving or
 * stopping navigation finishes it.
 */

/** A ride being recorded. */
export interface LiveRide {
  id: string;
  state: 'recording' | 'paused';
  startedAt: number;
  distanceMeters: number;
  /** Started by navigation; ends with it. */
  auto: boolean;
  routeName?: string;
}

/** Fewer metres than this isn't kept as a ride. */
const MIN_RIDE_METERS = 50;
const AUTO_RECORD_KEY = 'tc.autoRecordRides';
const META_KEY = 'tc.rideMeta';
const LINE_REDRAW_MS = 2_000;

interface RecorderState {
  id: string;
  state: 'recording' | 'paused' | 'finished';
  startedAt: number;
  endedAt?: number;
  /** Time recording, pauses left out, as of the moment read. */
  activeMs: number;
  distanceMeters: number;
}

interface Recorder {
  /** The ride under way or finished but not yet kept; null when none. */
  current(): Promise<RecorderState | null>;
  start(id: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Resolves once the raw track is complete. */
  finish(): Promise<void>;
  readRaw(id: string): Promise<string>;
  /** Forgets the raw track. */
  clear(id: string): Promise<void>;
  onChange(listener: (state: RecorderState) => void): void;
}

export class RideLogService {
  private recorder: Recorder = Capacitor.isNativePlatform() ? new NativeRecorder() : new WebRecorder();
  private live: LiveRide | null = null;
  /** Time recording, as of `activeAsOf`. */
  private activeMs = 0;
  private activeAsOf = 0;
  private liveLine: Coordinate[][] = [];
  private lineCounter = new DistanceCounter();
  private lastRedraw = 0;
  private finishing: Promise<RideRecord | null> | null = null;
  private wasNavigating = false;
  private autoRecord = readAutoRecord();
  private loaded: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private savedListeners = new Set<(ride: RideRecord | null, reason?: string) => void>();

  /** Picks up a ride under way (or one finished from the notification). */
  init(): Promise<void> {
    this.loaded ??= (async () => {
      this.recorder.onChange((state) => this.onRecorder(state));
      locationService.subscribe((fix) => {
        if (fix) this.onFix(fix);
      });
      navigationService.subscribe((nav) => this.onNavigation(nav));
      document.addEventListener('visibilitychange', () => {
        // Back from the background: the recorder kept going; redraw from its file.
        if (document.visibilityState === 'visible' && this.live) void this.reloadLine();
      });
      const state = await this.recorder.current().catch(() => null);
      if (state?.state === 'finished') {
        await this.finalize(state);
      } else if (state) {
        this.live = { ...readMeta(state.id), id: state.id, state: state.state, startedAt: state.startedAt, distanceMeters: state.distanceMeters };
        this.setActive(state.activeMs);
        await this.reloadLine();
      }
      this.emit();
    })();
    return this.loaded;
  }

  getLive(): LiveRide | null {
    return this.live;
  }

  /** Time recording so far, pauses left out. */
  activeSeconds(): number {
    if (!this.live) return 0;
    const running = this.live.state === 'recording' ? Date.now() - this.activeAsOf : 0;
    return Math.max(0, Math.round((this.activeMs + running) / 1000));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A ride was kept (or `null` with why it wasn't). */
  subscribeSaved(listener: (ride: RideRecord | null, reason?: string) => void): () => void {
    this.savedListeners.add(listener);
    return () => this.savedListeners.delete(listener);
  }

  getAutoRecord(): boolean {
    return this.autoRecord;
  }

  /** Record rides while navigating; remembered. */
  setAutoRecord(on: boolean): void {
    this.autoRecord = on;
    try {
      localStorage.setItem(AUTO_RECORD_KEY, on ? '1' : '0');
    } catch {
      // Kept for this session.
    }
    this.emit();
  }

  async start(options: { auto?: boolean; routeName?: string } = {}): Promise<void> {
    await this.init();
    if (this.live || this.finishing) return;
    await locationService.startWatching();
    if (locationService.wasPermissionDenied()) throw new Error('Allow location access to record a ride');
    const id = crypto.randomUUID();
    await this.recorder.start(id);
    const meta = { auto: options.auto ?? false, ...(options.routeName ? { routeName: options.routeName } : {}) };
    writeMeta(id, meta);
    this.live = { id, state: 'recording', startedAt: Date.now(), distanceMeters: 0, ...meta };
    this.setActive(0);
    this.liveLine = [];
    this.lineCounter = new DistanceCounter();
    mapService.setRideLine('live', null);
    this.emit();
  }

  async pause(): Promise<void> {
    if (this.live?.state !== 'recording') return;
    await this.recorder.pause();
    this.setActive(this.activeSeconds() * 1000);
    this.live = { ...this.live, state: 'paused' };
    this.emit();
  }

  async resume(): Promise<void> {
    if (this.live?.state !== 'paused') return;
    await this.recorder.resume();
    this.activeAsOf = Date.now();
    this.live = { ...this.live, state: 'recording' };
    // The line doesn't join across a pause.
    this.lineCounter.break();
    this.liveLine.push([]);
    this.emit();
  }

  /** Ends the ride and keeps it; null when too short to keep. */
  finish(): Promise<RideRecord | null> {
    if (this.finishing) return this.finishing;
    const live = this.live;
    if (!live) return Promise.resolve(null);
    this.finishing = (async () => {
      await this.recorder.finish();
      const state = (await this.recorder.current()) ?? {
        id: live.id,
        state: 'finished' as const,
        startedAt: live.startedAt,
        activeMs: this.activeSeconds() * 1000,
        distanceMeters: live.distanceMeters,
      };
      return this.finalize(state);
    })().finally(() => {
      this.finishing = null;
    });
    return this.finishing;
  }

  /** Ends the ride without keeping it. */
  async discard(): Promise<void> {
    const live = this.live;
    if (!live) return;
    await this.recorder.finish();
    await this.recorder.clear(live.id);
    this.endLive(live.id);
  }

  list(): Promise<RideRecord[]> {
    return rideRepository.list();
  }

  async rename(ride: RideRecord, name: string): Promise<RideRecord> {
    return rideRepository.save({ ...ride, name: name.trim() || ride.name });
  }

  async delete(ride: RideRecord): Promise<void> {
    await rideRepository.delete(ride.id);
  }

  /** The kept track, split where the ride was paused. */
  async track(ride: RideRecord): Promise<TrackFix[][]> {
    const stored = await rideRepository.getTrack(ride.id);
    return stored ? decodeTrack(stored, Date.parse(ride.startedAt)) : [];
  }

  /** Draws a past ride on the map and frames it. */
  async showOnMap(ride: RideRecord): Promise<void> {
    const segments = await this.track(ride);
    mapService.setRideLine('view', segments.map((segment) => segment.map((fix) => [fix.lon, fix.lat] as Coordinate)));
    const [west, south, east, north] = ride.bbox;
    mapService.fitBetweenPanels(west, south, east, north);
  }

  hideFromMap(): void {
    mapService.setRideLine('view', null);
  }

  /** The ride as a GPX file, to the share sheet (Android) or downloaded (browser). */
  async exportGpx(ride: RideRecord): Promise<boolean> {
    const gpx = toGpx(ride.name, await this.track(ride));
    const day = ride.startedAt.slice(0, 10);
    const fileName = `${slug(ride.name)}-${day}.gpx`;
    const text = {
      title: ride.name,
      text: `TrailCompass ride · ${(ride.distanceMeters / 1000).toFixed(1)} km`,
      dialogTitle: 'Share ride',
    };
    if (!Capacitor.isNativePlatform()) {
      return shareFile({ blob: new Blob([gpx], { type: 'application/gpx+xml' }) }, fileName, text);
    }
    const path = `shared-rides/${fileName}`;
    await Filesystem.writeFile({ path, data: gpx, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    return shareFile({ uri }, fileName, text);
  }

  /** Keeps the ride's path as a trip, to ride again from Library. */
  async saveAsTrip(ride: RideRecord): Promise<SavedRoute> {
    const coordinates = (await this.track(ride)).flat().map((fix) => [fix.lon, fix.lat] as Coordinate);
    if (coordinates.length < 2) throw new Error('This ride has no track to follow');
    const now = new Date().toISOString();
    return routeRepository.saveRoute({
      id: crypto.randomUUID(),
      name: ride.name,
      createdAt: now,
      updatedAt: now,
      start: coordinates[0]!,
      end: coordinates[coordinates.length - 1]!,
      waypoints: [],
      coordinates,
      distanceMeters: ride.distanceMeters,
      durationSeconds: ride.movingSeconds,
      instructions: [],
    });
  }

  private async finalize(state: RecorderState): Promise<RideRecord | null> {
    const meta = readMeta(state.id);
    const summary = summarizeTrack(parseRawTrack(await this.recorder.readRaw(state.id)));
    let ride: RideRecord | null = null;
    if (summary.bbox && summary.distanceMeters >= MIN_RIDE_METERS) {
      ride = await rideRepository.save(
        {
          id: state.id,
          name: rideName(new Date(state.startedAt)),
          startedAt: new Date(state.startedAt).toISOString(),
          endedAt: new Date(state.endedAt ?? Date.now()).toISOString(),
          distanceMeters: Math.round(summary.distanceMeters),
          movingSeconds: summary.movingSeconds,
          recordedSeconds: Math.round(state.activeMs / 1000),
          maxSpeedMps: summary.maxSpeedMps,
          climbMeters: summary.climbMeters,
          bbox: summary.bbox,
          preview: previewLine(summary.segments),
          source: locationService.getSource(),
          ...(meta.routeName ? { routeName: meta.routeName } : {}),
        },
        encodeTrack(summary.segments, state.startedAt),
      );
    }
    await this.recorder.clear(state.id);
    this.endLive(state.id);
    for (const listener of [...this.savedListeners]) {
      listener(ride, ride ? undefined : 'Too short to keep: under 50 m recorded');
    }
    return ride;
  }

  private endLive(id: string): void {
    clearMeta(id);
    if (this.live?.id === id) this.live = null;
    this.liveLine = [];
    mapService.setRideLine('live', null);
    this.emit();
  }

  private onRecorder(state: RecorderState): void {
    if (!this.live || state.id !== this.live.id) return;
    if (state.state === 'finished') {
      // Finished from the notification.
      if (!this.finishing) void this.finalize(state);
      return;
    }
    if (state.state !== this.live.state && state.state === 'recording') this.lineCounter.break();
    this.live = { ...this.live, state: state.state, distanceMeters: state.distanceMeters };
    this.setActive(state.activeMs);
    this.emit();
  }

  private onFix(fix: GpsFix): void {
    if (this.live?.state !== 'recording') return;
    const point = { t: fix.timestampMs, lat: fix.latitude, lon: fix.longitude, acc: fix.accuracyMeters ?? undefined };
    if (!this.lineCounter.add(point)) return;
    if (this.liveLine.length === 0) this.liveLine.push([]);
    this.liveLine[this.liveLine.length - 1]!.push([point.lon, point.lat]);
    if (Date.now() - this.lastRedraw >= LINE_REDRAW_MS) {
      this.lastRedraw = Date.now();
      mapService.setRideLine('live', this.liveLine);
    }
  }

  /** The line so far, from the recorder's file. */
  private async reloadLine(): Promise<void> {
    const live = this.live;
    if (!live) return;
    const segments = parseRawTrack(await this.recorder.readRaw(live.id));
    const counter = new DistanceCounter();
    const line: Coordinate[][] = [];
    for (const segment of segments) {
      counter.break();
      line.push(segment.filter((fix) => counter.add(fix)).map((fix) => [fix.lon, fix.lat] as Coordinate));
    }
    if (this.live?.id !== live.id) return;
    this.liveLine = line;
    this.lineCounter = counter;
    mapService.setRideLine('live', line);
  }

  private onNavigation(nav: NavigationState): void {
    const navigating = nav.status === 'navigating' || nav.status === 'rerouting' || nav.status === 'paused';
    if (navigating && !this.wasNavigating && this.autoRecord && !this.live) {
      const destination = tripPlanner.getState().destination?.name;
      void this.start({ auto: true, ...(destination ? { routeName: destination } : {}) }).catch(() => undefined);
    } else if (!navigating && this.wasNavigating && this.live?.auto) {
      void this.finish().catch(() => undefined);
    }
    this.wasNavigating = navigating;
  }

  private setActive(ms: number): void {
    this.activeMs = ms;
    this.activeAsOf = Date.now();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** Android: RideRecorderService records, also with the app closed. */
class NativeRecorder implements Recorder {
  async current(): Promise<RecorderState | null> {
    const ride = await RideLocation.recording();
    return 'id' in ride && ride.id ? fromNative(ride as NativeRecording) : null;
  }

  async start(id: string): Promise<void> {
    // The recording notification has the Pause and Finish buttons.
    await Downloads.requestNotifications().catch(() => undefined);
    await RideLocation.startRecording({ id });
  }

  pause(): Promise<void> {
    return RideLocation.pauseRecording();
  }

  resume(): Promise<void> {
    return RideLocation.resumeRecording();
  }

  async finish(): Promise<void> {
    await RideLocation.finishRecording();
    // The service writes the end of the track, then says it's finished.
    for (let i = 0; i < 50; i++) {
      const state = await this.current();
      if (!state || state.state === 'finished') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async readRaw(id: string): Promise<string> {
    try {
      const { data } = await Filesystem.readFile({ path: rawPath(id), directory: Directory.Data, encoding: Encoding.UTF8 });
      return typeof data === 'string' ? data : await data.text();
    } catch {
      return '';
    }
  }

  async clear(id: string): Promise<void> {
    await Filesystem.deleteFile({ path: rawPath(id), directory: Directory.Data }).catch(() => undefined);
    await RideLocation.clearRecording().catch(() => undefined);
  }

  onChange(listener: (state: RecorderState) => void): void {
    void RideLocation.addListener('recording', (ride) => {
      if ('id' in ride) listener(fromNative(ride));
    });
  }
}

/** A browser records from the page's own position updates while it's open. */
class WebRecorder implements Recorder {
  private static readonly KEY = 'tc.webRide';
  private raw = '';
  private counter = new DistanceCounter();
  private listeners = new Set<(state: RecorderState) => void>();
  private lastSave = 0;

  constructor() {
    locationService.subscribe((fix) => {
      if (fix) this.onFix(fix);
    });
  }

  async current(): Promise<RecorderState | null> {
    const saved = this.read();
    if (!saved) return null;
    if (!this.raw) {
      this.raw = (await storageManager.readTextFile(rawPath(saved.id, false))) ?? '';
      this.counter = new DistanceCounter();
      for (const segment of parseRawTrack(this.raw)) {
        this.counter.break();
        for (const fix of segment) this.counter.add(fix);
      }
    }
    return this.state(saved);
  }

  async start(id: string): Promise<void> {
    this.raw = '';
    this.counter = new DistanceCounter();
    this.write({ id, state: 'recording', startedAt: Date.now(), pausedMs: 0 });
  }

  async pause(): Promise<void> {
    const saved = this.read();
    if (saved?.state !== 'recording') return;
    this.raw += `#pause,${Date.now()}\n`;
    this.write({ ...saved, state: 'paused', pausedAt: Date.now() });
    await this.save(saved.id);
  }

  async resume(): Promise<void> {
    const saved = this.read();
    if (saved?.state !== 'paused') return;
    this.raw += `#resume,${Date.now()}\n`;
    this.counter.break();
    this.write({ ...saved, state: 'recording', pausedMs: saved.pausedMs + Date.now() - (saved.pausedAt ?? Date.now()), pausedAt: undefined });
  }

  async finish(): Promise<void> {
    const saved = this.read();
    if (!saved || saved.state === 'finished') return;
    const now = Date.now();
    this.raw += `#end,${now}\n`;
    const pausedMs = saved.pausedMs + (saved.pausedAt ? now - saved.pausedAt : 0);
    this.write({ ...saved, state: 'finished', pausedMs, pausedAt: undefined, endedAt: now });
    await this.save(saved.id);
  }

  async readRaw(id: string): Promise<string> {
    return this.read()?.id === id && this.raw ? this.raw : ((await storageManager.readTextFile(rawPath(id, false))) ?? '');
  }

  async clear(id: string): Promise<void> {
    if (this.read()?.id === id) {
      localStorage.removeItem(WebRecorder.KEY);
      this.raw = '';
    }
    await storageManager.deleteFile(rawPath(id, false));
  }

  onChange(listener: (state: RecorderState) => void): void {
    this.listeners.add(listener);
  }

  private onFix(fix: GpsFix): void {
    const saved = this.read();
    if (saved?.state !== 'recording') return;
    const point: TrackFix = {
      t: fix.timestampMs,
      lat: fix.latitude,
      lon: fix.longitude,
      ...(fix.accuracyMeters != null ? { acc: fix.accuracyMeters } : {}),
      ...(fix.altitudeMeters != null ? { alt: fix.altitudeMeters } : {}),
      ...(fix.speedMps != null ? { speed: fix.speedMps } : {}),
    };
    this.raw += rawLine(point);
    this.counter.add(point);
    for (const listener of this.listeners) listener(this.state(saved));
    if (Date.now() - this.lastSave > 15_000) void this.save(saved.id);
  }

  private async save(id: string): Promise<void> {
    this.lastSave = Date.now();
    await storageManager.writeTextFile(rawPath(id, false), this.raw);
  }

  private state(saved: WebRide): RecorderState {
    const end = saved.endedAt ?? saved.pausedAt ?? Date.now();
    return {
      id: saved.id,
      state: saved.state,
      startedAt: saved.startedAt,
      ...(saved.endedAt ? { endedAt: saved.endedAt } : {}),
      activeMs: Math.max(0, end - saved.startedAt - saved.pausedMs),
      distanceMeters: this.counter.distanceMeters,
    };
  }

  private read(): WebRide | null {
    try {
      return JSON.parse(localStorage.getItem(WebRecorder.KEY) ?? 'null') as WebRide | null;
    } catch {
      return null;
    }
  }

  private write(ride: WebRide): void {
    localStorage.setItem(WebRecorder.KEY, JSON.stringify(ride));
    for (const listener of this.listeners) listener(this.state(ride));
  }
}

interface WebRide {
  id: string;
  state: 'recording' | 'paused' | 'finished';
  startedAt: number;
  endedAt?: number;
  pausedAt?: number;
  pausedMs: number;
}

function fromNative(ride: NativeRecording): RecorderState {
  return {
    id: ride.id,
    state: ride.state,
    startedAt: ride.startedAt,
    ...(ride.endedAt ? { endedAt: ride.endedAt } : {}),
    activeMs: ride.activeMs,
    distanceMeters: ride.distanceMeters,
  };
}

/** Where the raw track is: from Directory.Data (Android), or for storageManager. */
function rawPath(id: string, native = true): string {
  return native ? `map-packages/rides/${id}.csv` : `rides/${id}.csv`;
}

function readAutoRecord(): boolean {
  try {
    return localStorage.getItem(AUTO_RECORD_KEY) !== '0';
  } catch {
    return true;
  }
}

/** What the recorder doesn't know: whether navigation started the ride, and the trip. */
function readMeta(id: string): { auto: boolean; routeName?: string } {
  try {
    const meta = JSON.parse(localStorage.getItem(META_KEY) ?? 'null') as { id?: string; auto?: boolean; routeName?: string } | null;
    if (meta?.id === id) return { auto: meta.auto ?? false, ...(meta.routeName ? { routeName: meta.routeName } : {}) };
  } catch {
    // None.
  }
  return { auto: false };
}

function writeMeta(id: string, meta: { auto: boolean; routeName?: string }): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify({ id, ...meta }));
  } catch {
    // Without it, the ride just isn't finished by navigation.
  }
}

function clearMeta(id: string): void {
  try {
    const meta = JSON.parse(localStorage.getItem(META_KEY) ?? 'null') as { id?: string } | null;
    if (meta?.id === id) localStorage.removeItem(META_KEY);
  } catch {
    // Nothing to clear.
  }
}

function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'ride'
  );
}

export const rideLogService = new RideLogService();
