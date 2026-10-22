import type { CompassReading } from '../types/navigation';

interface CompassWidgetProps {
  reading: CompassReading | null;
  onEnable?: () => void;
}

export function CompassWidget({ reading, onEnable }: CompassWidgetProps) {
  const heading = reading?.headingDegrees ?? null;
  const unavailable = !reading || reading.accuracy === 'unavailable' || heading == null;

  return (
    <div className="tc-compass" aria-live="polite">
      <div className="tc-compass-dial" aria-hidden={!unavailable}>
        <div
          className="tc-compass-needle"
          style={{
            transform: unavailable ? undefined : `rotate(${heading}deg)`,
          }}
        />
        <span className="tc-compass-n">N</span>
      </div>
      <div className="tc-compass-meta">
        <strong className="tc-compass-heading">
          {unavailable ? '—' : `${Math.round(heading)}°`}
        </strong>
        <span className="tc-compass-accuracy">
          {reading?.accuracy ?? 'unavailable'}
        </span>
        {reading?.needsCalibration && (
          <span className="tc-compass-warn">Calibration recommended</span>
        )}
        {reading?.message && (
          <span className="tc-compass-msg">{reading.message}</span>
        )}
        {unavailable && onEnable && (
          <button type="button" className="tc-btn tc-btn-secondary" onClick={onEnable}>
            Enable compass
          </button>
        )}
      </div>
    </div>
  );
}
