import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Where the phone's position comes from (android/…/LocationHub.java):
 * satellites only, satellites helped by Wi-Fi and mobile networks, or
 * networks only.
 */
export type LocationSource = 'gps' | 'assisted' | 'saver';

/** A position from RideLocationPlugin.java. */
export interface NativeFix {
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number;
  speed?: number;
  bearing?: number;
  /** ms since 1970 */
  time: number;
  provider: string;
  /** Satellites used in the last satellite fix. */
  satellites: number;
}

/** A ride RideRecorderService.java is recording, or has finished. */
export interface NativeRecording {
  id: string;
  state: 'recording' | 'paused' | 'finished';
  startedAt: number;
  endedAt?: number;
  /** Time recording, pauses left out. */
  activeMs: number;
  distanceMeters: number;
  points: number;
  /** The raw track, in Directory.Data. */
  path: string;
}

export interface LocationStatus {
  source: LocationSource;
  /** The phone's location setting for satellites / networks. */
  gpsEnabled: boolean;
  networkEnabled: boolean;
  satellites: number;
}

interface RideLocationPlugin {
  watch(options: { source: LocationSource }): Promise<void>;
  clearWatch(): Promise<void>;
  setSource(options: { source: LocationSource }): Promise<void>;
  status(): Promise<LocationStatus>;
  openLocationSettings(): Promise<void>;
  startRecording(options: { id: string }): Promise<void>;
  pauseRecording(): Promise<void>;
  resumeRecording(): Promise<void>;
  finishRecording(): Promise<void>;
  /** `{}` when there's no ride. */
  recording(): Promise<NativeRecording | Record<string, never>>;
  clearRecording(): Promise<void>;
  addListener(event: 'fix', listener: (fix: NativeFix) => void): Promise<PluginListenerHandle>;
  addListener(event: 'recording', listener: (ride: NativeRecording) => void): Promise<PluginListenerHandle>;
}

export const RideLocation = registerPlugin<RideLocationPlugin>('RideLocation');
