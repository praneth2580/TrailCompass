/**
 * Progress for road download / route calculation.
 * `percent` is only set when we have a real total (e.g. Content-Length).
 * Otherwise keep it null and show an indeterminate loader — never fake %.
 */
export type RoutingPhase =
  | 'idle'
  | 'checking-cache'
  | 'downloading-roads'
  | 'building-graph'
  | 'calculating'
  | 'done'
  | 'error';

export interface RoutingProgress {
  phase: RoutingPhase;
  label: string;
  /** 0–100 when known; null when unknown (no fake numbers). */
  percent: number | null;
  bytesReceived?: number;
  bytesTotal?: number;
}

export type RoutingProgressListener = (progress: RoutingProgress) => void;

export function idleProgress(): RoutingProgress {
  return { phase: 'idle', label: '', percent: null };
}
