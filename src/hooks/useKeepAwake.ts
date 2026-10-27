import { useEffect } from 'react';
import { KeepAwake } from '@capacitor-community/keep-awake';

/**
 * Keep the screen on while `active` (turn-by-turn navigation), so the
 * phone's sleep timeout does not blank the map mid-ride.
 */
export function useKeepAwake(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    // The web Wake Lock is dropped whenever the page is hidden; take it again.
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      void KeepAwake.keepAwake().catch(() => {
        // Unsupported (e.g. an older desktop browser) — nothing to do.
      });
    };

    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      document.removeEventListener('visibilitychange', acquire);
      void KeepAwake.allowSleep().catch(() => undefined);
    };
  }, [active]);
}
