import { useEffect, useState } from 'react';
import { rideInsights, type RideGroups } from '../services/ride-insights.service';
import { rideLogService } from '../services/ride-log.service';

/**
 * The ride log as routes and places, while `enabled`. Updates as place
 * names are found and when a ride is kept.
 */
export function useRideGroups(enabled: boolean): { groups: RideGroups | null; error: string | null } {
  const [groups, setGroups] = useState<RideGroups | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let running = false;
    let again = false;
    const load = async () => {
      // One at a time; a change while loading loads once more after.
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const next = await rideInsights.groups();
          if (alive) {
            setGroups(next);
            setError(null);
          }
        } while (again && alive);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not sort your rides');
      } finally {
        running = false;
      }
    };
    void load();
    const offNames = rideInsights.subscribe(() => void load());
    const offSaved = rideLogService.subscribeSaved(() => void load());
    return () => {
      alive = false;
      offNames();
      offSaved();
    };
  }, [enabled]);

  return { groups, error };
}
