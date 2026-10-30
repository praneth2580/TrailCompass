import { formatEtaShort } from '../routing/route-naming';
import type { TrafficLevel } from './ride-insights';
import type { RidePeriod } from './ride-track';

/** Words for the ride log's lists. */

/** "12.4 km", "342 km" */
export function formatKm(meters: number): string {
  const km = meters / 1000;
  return km >= 100 ? `${Math.round(km).toLocaleString()} km` : `${km.toFixed(1)} km`;
}

/** "32 min", "1h 5m" */
export function formatDuration(seconds: number): string {
  return formatEtaShort(Math.round(seconds));
}

/** Against the usual time: "+4 min", "−3 min", or "usual" within half a minute. */
export function formatDifference(seconds: number, usual: number): string {
  const difference = seconds - usual;
  if (Math.abs(difference) < 30) return 'usual';
  const minutes = Math.max(1, Math.round(Math.abs(difference) / 60));
  return `${difference > 0 ? '+' : '−'}${minutes} min`;
}

/** "8 AM", or "08:00" where the clock is 24-hour. */
export function formatHour(hour: number): string {
  const label = new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' });
  return /^\d+$/.test(label) ? `${label}:00` : label;
}

export const PERIOD_LABELS: Record<RidePeriod, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  night: 'Night',
};

export const PERIODS: RidePeriod[] = ['morning', 'afternoon', 'evening', 'night'];

export const TRAFFIC_LABELS: Record<TrafficLevel, { name: string; speeds: string }> = {
  clear: { name: 'Clear', speeds: 'over 35 km/h' },
  moderate: { name: 'Moderate', speeds: '20–35 km/h' },
  slow: { name: 'Slow', speeds: '10–20 km/h' },
  jammed: { name: 'Jammed', speeds: 'under 10 km/h' },
};
