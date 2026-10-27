import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Native side: android/app/src/main/java/com/example/trailcompass/DownloadsPlugin.java
 * A foreground service with a progress notification keeps route planning
 * running while the app is in the background, and the plugin reports
 * which kind of network the phone is on.
 */

export type NetworkType = 'wifi' | 'cellular' | 'other' | 'none' | 'unknown';

export interface DownloadNotice {
  title: string;
  text: string;
  /** 0–100, or null for a bar that just shows activity. */
  percent?: number | null;
  /** Shows Resume instead of Pause. */
  paused?: boolean;
}

export type DownloadAction = 'pause' | 'resume' | 'stop';

interface DownloadsPlugin {
  /** Asks for notification permission on Android 13+. */
  requestNotifications(): Promise<{ granted: boolean }>;
  /** Starts the foreground service; only allowed while the app is on screen. */
  startService(options: DownloadNotice): Promise<void>;
  update(options: DownloadNotice): Promise<void>;
  /** Stops the service; with `notify`, leaves a notification saying how it ended. */
  finish(options: { title: string; text: string; ok: boolean; notify: boolean }): Promise<void>;
  stopService(): Promise<void>;
  getNetwork(): Promise<{ type: NetworkType }>;
  addListener(
    eventName: 'action',
    listener: (event: { action: DownloadAction }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'network',
    listener: (event: { type: NetworkType }) => void,
  ): Promise<PluginListenerHandle>;
}

export const Downloads = registerPlugin<DownloadsPlugin>('Downloads');
