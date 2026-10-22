import type { CompassReading } from '../types/navigation';

interface CompassWidgetProps {
  reading: CompassReading | null;
  onEnable?: () => void;
}

export function CompassWidget({ reading, onEnable }: CompassWidgetProps) {
  const heading = reading?.headingDegrees ?? null;
  const unavailable =
    !reading || reading.accuracy === 'unavailable' || heading == null;
  const displayHeading = unavailable ? null : Math.round(heading);
  const detail = unavailable
    ? reading?.message?.split('—')[0]?.trim() || 'No heading'
    : reading?.accuracy;

  return (
    <div className="tc-compass" aria-live="polite">
      <div
        className="tc-compass-dial"
        aria-hidden={unavailable}
        data-unavailable={unavailable || undefined}
      >
        <span className="tc-compass-tick tc-compass-tick-n" aria-hidden>
          N
        </span>
        <span className="tc-compass-tick tc-compass-tick-e" aria-hidden>
          E
        </span>
        <span className="tc-compass-tick tc-compass-tick-s" aria-hidden>
          S
        </span>
        <span className="tc-compass-tick tc-compass-tick-w" aria-hidden>
          W
        </span>
        <div
          className="tc-compass-needle"
          style={{
            transform: unavailable ? undefined : `rotate(${heading}deg)`,
          }}
        >
          <span className="tc-compass-needle-tip" />
          <span className="tc-compass-needle-tail" />
        </div>
        <span className="tc-compass-hub" aria-hidden />
      </div>

      <div className="tc-compass-meta">
        <strong className="tc-compass-heading">
          {displayHeading == null ? '—' : `${displayHeading}°`}
        </strong>
        <span className="tc-compass-accuracy">{detail}</span>
        {!unavailable && reading?.needsCalibration ? (
          <span className="tc-compass-warn">Calibrate</span>
        ) : null}
        {unavailable && onEnable ? (
          <button
            type="button"
            className="tc-btn tc-btn-ghost"
            onClick={onEnable}
          >
            Enable
          </button>
        ) : null}
      </div>
    </div>
  );
}
