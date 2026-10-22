import type { CompassReading } from '../types/navigation';

export type CompassListener = (reading: CompassReading) => void;

/**
 * Device-orientation compass using the browser AbsoluteOrientation / DeviceOrientation APIs.
 * On Android WebView this may require user gesture / permissions; magnetic mounts can skew readings.
 */
export class CompassService {
  private listeners = new Set<CompassListener>();
  private listening = false;
  private smoothed: number | null = null;
  private readonly alpha = 0.2;

  subscribe(listener: CompassListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.listening) return;

    // iOS 13+ / some Android browsers require permission.
    const doe = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (typeof doe.requestPermission === 'function') {
      try {
        const result = await doe.requestPermission();
        if (result !== 'granted') {
          this.emitUnavailable('Orientation permission denied — compass unavailable');
          return;
        }
      } catch {
        this.emitUnavailable('Unable to request orientation permission');
        return;
      }
    }

    if (!('DeviceOrientationEvent' in window)) {
      this.emitUnavailable('Device orientation sensors unavailable on this device');
      return;
    }

    window.addEventListener('deviceorientation', this.onOrientation, true);
    this.listening = true;

    // Emit an initial status so UI is not blank while waiting for first event.
    this.emit({
      headingDegrees: null,
      accuracy: 'unavailable',
      needsCalibration: true,
      message: 'Waiting for compass sensors… wave the phone in a figure-8 to calibrate',
      timestampMs: Date.now(),
    });
  }

  stop(): void {
    if (!this.listening) return;
    window.removeEventListener('deviceorientation', this.onOrientation, true);
    this.listening = false;
    this.smoothed = null;
  }

  private onOrientation = (event: DeviceOrientationEvent): void => {
    // Prefer webkitCompassHeading on iOS when present; else absolute alpha.
    const webkitHeading = (
      event as DeviceOrientationEvent & { webkitCompassHeading?: number }
    ).webkitCompassHeading;

    let heading: number | null = null;
    if (typeof webkitHeading === 'number' && Number.isFinite(webkitHeading)) {
      heading = webkitHeading;
    } else if (event.absolute && typeof event.alpha === 'number') {
      // alpha: 0–360, convert so 0 ≈ north when absolute is true
      heading = (360 - event.alpha) % 360;
    } else if (typeof event.alpha === 'number') {
      heading = (360 - event.alpha) % 360;
    }

    if (heading == null || !Number.isFinite(heading)) {
      this.emit({
        headingDegrees: null,
        accuracy: 'unavailable',
        needsCalibration: true,
        message: 'Compass data unavailable — check sensors and calibration',
        timestampMs: Date.now(),
      });
      return;
    }

    this.smoothed =
      this.smoothed == null
        ? heading
        : this.smoothAngle(this.smoothed, heading, this.alpha);

    const abs = (event as DeviceOrientationEvent & { absolute?: boolean }).absolute;
    const accuracy: CompassReading['accuracy'] = abs ? 'medium' : 'low';

    this.emit({
      headingDegrees: this.smoothed,
      accuracy,
      needsCalibration: accuracy === 'low',
      message:
        accuracy === 'low'
          ? 'Relative orientation only — calibrate away from metal mounts'
          : undefined,
      timestampMs: Date.now(),
    });
  };

  private smoothAngle(prev: number, next: number, alpha: number): number {
    const delta = ((next - prev + 540) % 360) - 180;
    return (prev + alpha * delta + 360) % 360;
  }

  private emitUnavailable(message: string): void {
    this.emit({
      headingDegrees: null,
      accuracy: 'unavailable',
      needsCalibration: false,
      message,
      timestampMs: Date.now(),
    });
  }

  private emit(reading: CompassReading): void {
    for (const listener of this.listeners) {
      listener(reading);
    }
  }
}

export const compassService = new CompassService();
