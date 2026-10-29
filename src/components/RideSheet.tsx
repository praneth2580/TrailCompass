import { useId, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useBackHandler } from '../hooks/useBackHandler';
import { formatClock } from '../routing/route-naming';
import type { LiveRide } from '../services/ride-log.service';

interface RideSheetProps {
  ride: LiveRide | null;
  open: boolean;
  /** Time recording, pauses left out. */
  seconds: number;
  busy: boolean;
  onClose: () => void;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  onDiscard: () => void;
}

/** The ride being recorded: its numbers, Pause or Resume, Finish. */
export function RideSheet({ ride, open, seconds, busy, onClose, onPause, onResume, onFinish, onDiscard }: RideSheetProps) {
  const titleId = useId();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const close = () => {
    setConfirmDiscard(false);
    onClose();
  };
  useBackHandler(open && ride != null, close);
  if (!open || !ride) return null;

  const recording = ride.state === 'recording';
  const average = seconds > 0 ? (ride.distanceMeters / seconds) * 3.6 : 0;

  return (
    <div className="tc-sheet-root" role="presentation">
      <button type="button" className="tc-sheet-backdrop" aria-label="Close" onClick={close} disabled={busy} />
      <div className="tc-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="tc-sheet-handle" aria-hidden />
        <header className="tc-sheet-header">
          <h2 id={titleId} className="tc-sheet-title">
            <span className="tc-rec-dot" data-state={ride.state} aria-hidden />
            {recording ? 'Recording ride' : 'Ride paused'}
          </h2>
          <p className="tc-sheet-hint">
            {ride.routeName ? `To ${ride.routeName}. ` : ''}
            {Capacitor.isNativePlatform()
              ? 'Keeps recording with the screen off or the app closed; the notification has Pause and Finish too.'
              : 'Keep this page open while you ride.'}
          </p>
        </header>

        <dl className="tc-ride-stats">
          <div>
            <dt>Distance</dt>
            <dd>{(ride.distanceMeters / 1000).toFixed(2)} km</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>{formatClock(seconds)}</dd>
          </div>
          <div>
            <dt>Average</dt>
            <dd>{Math.round(average)} km/h</dd>
          </div>
        </dl>

        {confirmDiscard ? (
          <div className="tc-offline-confirm" role="group" aria-label="Discard ride">
            <p>Discard this ride? It won't be saved.</p>
            <div className="tc-sheet-actions">
              <button type="button" className="tc-btn tc-btn-secondary" onClick={() => setConfirmDiscard(false)}>
                Keep it
              </button>
              <button type="button" className="tc-btn tc-btn-danger" onClick={onDiscard} disabled={busy}>
                Discard
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="tc-sheet-actions">
              <button type="button" className="tc-btn tc-btn-secondary" onClick={recording ? onPause : onResume} disabled={busy}>
                {recording ? 'Pause' : 'Resume'}
              </button>
              <button type="button" className="tc-btn" onClick={onFinish} disabled={busy}>
                {busy ? (
                  <>
                    <span className="tc-spinner tc-spinner-sm" aria-hidden />
                    Saving…
                  </>
                ) : (
                  'Finish ride'
                )}
              </button>
            </div>
            <button type="button" className="tc-offline-link tc-offline-link-danger tc-ride-discard" onClick={() => setConfirmDiscard(true)} disabled={busy}>
              Discard ride
            </button>
          </>
        )}
      </div>
    </div>
  );
}
