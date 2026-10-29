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
  private eventName: 'deviceorientationabsolute' | 'deviceorientation' =
    'deviceorientation';

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
          this.emitUnavailable('Permission denied');
          return;
        }
      } catch {
        this.emitUnavailable('Permission failed');
        return;
      }
    }

    if (!('DeviceOrientationEvent' in window)) {
      this.emitUnavailable('No sensors');
      return;
    }

    // Chromium (incl. Android WebView) reports plain `deviceorientation`
    // relative to where the phone started; the absolute event is north-based.
    // iOS lacks it but adds webkitCompassHeading to the plain event.
    this.eventName =
      'ondeviceorientationabsolute' in window
        ? 'deviceorientationabsolute'
        : 'deviceorientation';
    window.addEventListener(this.eventName, this.onOrientation, true);
    this.listening = true;

    // Emit an initial status so UI is not blank while waiting for first event.
    this.emit({
      headingDegrees: null,
      accuracy: 'unavailable',
      needsCalibration: true,
      message: 'Waiting for sensors',
      timestampMs: Date.now(),
    });
  }

  stop(): void {
    if (!this.listening) return;
    window.removeEventListener(this.eventName, this.onOrientation, true);
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
        message: 'No reading',
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
      message: accuracy === 'low' ? 'Low accuracy' : undefined,
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
