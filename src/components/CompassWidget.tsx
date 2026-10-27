import { useId, useState } from 'react';
import type { CompassReading } from '../types/navigation';

interface CompassWidgetProps {
  reading: CompassReading | null;
  onEnable?: () => void;
  /** Makes the compass a button (the map HUD opens zen mode with it). */
  onOpen?: () => void;
  /** 'zen': the large compass shown in zen mode. */
  variant?: 'chip' | 'zen';
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const LETTERS = ['N', 'E', 'S', 'W'];

/**
 * Face geometry in a 200-unit box centred on 0,0 (0° up, clockwise).
 * The chip is ~44px across, so it keeps only bold marks.
 */
const FACE = {
  chip: {
    ticks: [45, 135, 225, 315],
    tick: { outer: 94, minor: 82, major: 82 },
    letterRadius: 60,
    numerals: [] as number[],
    needle: { tip: 70, tail: 50, half: 13 },
  },
  zen: {
    ticks: Array.from({ length: 72 }, (_, i) => i * 5),
    tick: { outer: 90, minor: 84, major: 78 },
    letterRadius: 60,
    numerals: [30, 60, 120, 150, 210, 240, 300, 330],
    needle: { tip: 76, tail: 46, half: 8.5 },
  },
};

const BEAM_RADIUS = 88;
const BEAM_HALF_ANGLE = 26;

/** Point on the face at `deg` (0° up, clockwise) and radius `r`. */
function polar(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [
    Math.round(r * Math.sin(rad) * 100) / 100,
    Math.round(-r * Math.cos(rad) * 100) / 100,
  ];
}

const BEAM_PATH = (() => {
  const [x1, y1] = polar(-BEAM_HALF_ANGLE, BEAM_RADIUS);
  const [x2, y2] = polar(BEAM_HALF_ANGLE, BEAM_RADIUS);
  return `M0 0L${x1} ${y1}A${BEAM_RADIUS} ${BEAM_RADIUS} 0 0 1 ${x2} ${y2}Z`;
})();

/**
 * Keeps the needle angle continuous, so 359° → 1° turns 2° clockwise
 * instead of spinning the long way round.
 */
function useUnwrappedHeading(heading: number | null): number | null {
  const [track, setTrack] = useState({ heading, angle: heading });
  if (heading === track.heading) return heading == null ? null : track.angle;

  const angle =
    heading == null || track.angle == null
      ? (heading ?? track.angle)
      : track.angle + ((((heading - track.angle) % 360) + 540) % 360) - 180;
  setTrack({ heading, angle });
  return heading == null ? null : angle;
}

export function CompassWidget({
  reading,
  onEnable,
  onOpen,
  variant = 'chip',
}: CompassWidgetProps) {
  const heading = reading?.headingDegrees ?? null;
  const unavailable =
    !reading || reading.accuracy === 'unavailable' || heading == null;
  const angle = useUnwrappedHeading(unavailable ? null : heading);
  const beamId = `tc-beam-${useId().replace(/[^\w-]/g, '')}`;
  const displayHeading = unavailable ? null : Math.round(heading) % 360;
  const detail = unavailable
    ? reading?.message?.split('—')[0]?.trim() || 'No heading'
    : reading?.accuracy;

  const label =
    displayHeading == null ? 'Compass unavailable' : `Heading ${displayHeading} degrees`;
  const showEnable =
    unavailable &&
    onEnable &&
    (reading == null || /permission/i.test(reading.message ?? ''));

  const face = FACE[variant];
  const { tip, tail, half } = face.needle;
  const zen = variant === 'zen';

  const dial = (
    <div className="tc-compass-dial" aria-hidden data-unavailable={unavailable || undefined}>
      <svg className="tc-compass-face" viewBox="-100 -100 200 200">
        {zen ? <circle className="tc-compass-ring" r={96} /> : null}
        {face.ticks.map((deg) => {
          const major = deg % 30 === 0;
          const [x1, y1] = polar(deg, face.tick.outer);
          const [x2, y2] = polar(deg, major ? face.tick.major : face.tick.minor);
          return deg === 0 && zen ? null : (
            <line
              key={deg}
              className="tc-compass-mark"
              data-major={major || undefined}
              data-cardinal={deg % 90 === 0 || undefined}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
            />
          );
        })}
        {zen ? <path className="tc-compass-north" d="M0 -77L-7 -91L7 -91Z" /> : null}
        {LETTERS.map((letter, i) => {
          const [x, y] = polar(i * 90, face.letterRadius);
          return (
            <text
              key={letter}
              className={i === 0 ? 'tc-compass-letter tc-compass-letter-n' : 'tc-compass-letter'}
              x={x}
              y={y}
            >
              {letter}
            </text>
          );
        })}
        {face.numerals.map((deg) => {
          const [x, y] = polar(deg, 64);
          return (
            <text key={deg} className="tc-compass-numeral" x={x} y={y}>
              {deg}
            </text>
          );
        })}
      </svg>

      <div
        className="tc-compass-needle"
        style={{ transform: angle == null ? undefined : `rotate(${angle}deg)` }}
      >
        <svg viewBox="-100 -100 200 200">
          {zen ? (
            <>
              <defs>
                <radialGradient id={beamId} cx={0} cy={0} r={BEAM_RADIUS} gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#f0a020" stopOpacity={0.55} />
                  <stop offset="1" stopColor="#f0a020" stopOpacity={0} />
                </radialGradient>
              </defs>
              <path d={BEAM_PATH} fill={`url(#${beamId})`} />
            </>
          ) : null}
          {/* Two shades per half give the needle a bevelled edge. */}
          <path className="tc-compass-needle-lit" d={`M0 ${-tip}L${-half} 0H0Z`} />
          <path className="tc-compass-needle-shade" d={`M0 ${-tip}L${half} 0H0Z`} />
          <path className="tc-compass-tail-lit" d={`M0 ${tail}L${-half} 0H0Z`} />
          <path className="tc-compass-tail-shade" d={`M0 ${tail}L${half} 0H0Z`} />
        </svg>
      </div>
      <span className="tc-compass-hub" />
    </div>
  );

  const meta = (
    <div className="tc-compass-meta">
      <strong className="tc-compass-heading">
        {displayHeading == null ? '—' : `${displayHeading}°`}
      </strong>
      {zen && displayHeading != null ? (
        <span className="tc-compass-cardinal">
          {CARDINALS[Math.round(displayHeading / 45) % 8]}
        </span>
      ) : null}
      <span
        className="tc-compass-accuracy"
        data-accuracy={unavailable ? 'unavailable' : reading?.accuracy}
      >
        {detail}
      </span>
    </div>
  );

  return (
    <div
      className={zen ? 'tc-compass tc-compass-zen' : 'tc-compass'}
      aria-live="polite"
      aria-label={label}
    >
      {onOpen ? (
        <button
          type="button"
          className="tc-compass-open"
          onClick={onOpen}
          aria-label={`${label}. Open zen mode`}
        >
          {dial}
          {meta}
        </button>
      ) : (
        <>
          {dial}
          {meta}
        </>
      )}
      {showEnable ? (
        <button type="button" className="tc-btn tc-btn-ghost" onClick={onEnable}>
          Enable
        </button>
      ) : null}
    </div>
  );
}
