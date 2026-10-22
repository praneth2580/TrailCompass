import { useEffect, useRef, useState } from 'react';
import type { GpsFix, NavigationStatus } from '../types/navigation';

/** Enter ride view once sustained motion is detected (~12 km/h). */
const ENTER_MPS = 3.5;
/** Leave ride view after sustained near-stop (~4 km/h). */
const EXIT_MPS = 1.2;
const ENTER_HOLD_MS = 2200;
const EXIT_HOLD_MS = 4500;

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

  useEffect(() => {
    speedRef.current = fix?.speedMps ?? null;
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
      const speed = speedRef.current;
      const now = Date.now();

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

      if (speed == null || speed > EXIT_MPS) {
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
