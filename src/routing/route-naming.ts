import type { CalculatedRoute } from './routing-adapter';
import type { RoutingProfileId } from './routing-profiles';
import { getProfile } from './routing-profiles';

/** Human-friendly default name for a planned route. */
export function suggestRouteName(
  route: CalculatedRoute,
  profile?: RoutingProfileId,
): string {
  const distance = formatDistanceShort(route.distanceMeters);
  const eta = formatEtaShort(route.durationSeconds);
  const profileLabel = getProfile(profile ?? route.profile ?? 'fastest').label;
  const when = formatStamp(new Date());
  return `${profileLabel} · ${distance} · ${eta} · ${when}`;
}

export function formatDistanceShort(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

export function formatEtaShort(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatStamp(date: Date): string {
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
