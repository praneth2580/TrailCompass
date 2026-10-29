import { useEffect, useRef, useState } from 'react';
import type { GpsFix, NavigationStatus } from '../types/navigation';

/** Enter ride view once sustained motion is detected (~12 km/h). */
const ENTER_MPS = 3.5;
/** At or below this (~5 km/h) the rider counts as stopped; clears GPS jitter. */
const STOPPED_MPS = 1.5;
const ENTER_HOLD_MS = 2200;
/** How long the rider must stay stopped before ride view closes. */
const EXIT_HOLD_MS = 5000;
/**
 * GPS goes quiet at a standstill (Android throttles a still phone), which
 * would leave the last moving speed in place. No fix for this long, or for
 * twice the usual gap between fixes, counts as stopped.
 */
const STALE_FIX_MS = 8000;
const STALE_FIX_MAX_MS = 30_000;

interface RideFullscreenInput {
  status: NavigationStatus;
  fix: GpsFix | null;
}

/**
 * Immersive map mode while the rider is moving during active navigation.
 * Exits on Stop / arrive / error, or after sitting still long enough.
 */
export function useRideFullscreen({
  status,
  fix,
}: RideFullscreenInput): {
  rideMode: boolean;
  dismissRideMode: () => void;
} {
  const navigating = status === 'navigating' || status === 'rerouting';
  const [movingRide, setMovingRide] = useState(false);
  const [manualOff, setManualOff] = useState(false);
  const enterSince = useRef<number | null>(null);
  const exitSince = useRef<number | null>(null);
  const speedRef = useRef<number | null>(null);
  const fixAt = useRef<number | null>(null);
  const fixGapMs = useRef(0);

  useEffect(() => {
    if (!fix) return;
    const now = Date.now();
    if (fixAt.current != null) fixGapMs.current = now - fixAt.current;
    fixAt.current = now;
    speedRef.current = fix.speedMps;
  }, [fix]);

  useEffect(() => {
    if (!navigating) {
      enterSince.current = null;
      exitSince.current = null;
      queueMicrotask(() => {
        setMovingRide(false);
        setManualOff(false);
      });
      return;
    }

    const tick = () => {
      const now = Date.now();
      const staleAfter = Math.max(
        STALE_FIX_MS,
        Math.min(2 * fixGapMs.current, STALE_FIX_MAX_MS),
      );
      const stale = fixAt.current != null && now - fixAt.current > staleAfter;
      const speed = stale ? 0 : speedRef.current;

      if (speed != null && speed >= ENTER_MPS) {
        exitSince.current = null;
        if (enterSince.current == null) enterSince.current = now;
        if (now - enterSince.current >= ENTER_HOLD_MS) {
          setManualOff(false);
          setMovingRide(true);
        }
        return;
      }

      enterSince.current = null;

      // Unknown speed counts as stopped: devices drop it once motion ends.
      if (speed != null && speed > STOPPED_MPS) {
        exitSince.current = null;
        return;
      }

      if (exitSince.current == null) exitSince.current = now;
      if (now - exitSince.current >= EXIT_HOLD_MS) {
        setMovingRide(false);
      }
    };

    tick();
    const id = window.setInterval(tick, 400);
    return () => window.clearInterval(id);
  }, [navigating]);

  return {
    rideMode: navigating && movingRide && !manualOff,
    dismissRideMode: () => {
      setManualOff(true);
      setMovingRide(false);
      enterSince.current = null;
      exitSince.current = null;
    },
  };
}

/** Best-effort browser fullscreen; fails quietly without a user gesture. */
export async function setBrowserFullscreen(active: boolean): Promise<void> {
  try {
    if (active) {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen?.();
      }
    } else if (document.fullscreenElement) {
      await document.exitFullscreen?.();
    }
  } catch {
    // Gesture / policy — immersive CSS still applies.
  }
}
