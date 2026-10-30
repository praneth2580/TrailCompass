import { useEffect, useState } from 'react';
import { mapService } from '../services/map.service';

/** Shows only while the map is turned; tapping it puts north back up. */
export function NorthButton() {
  const [bearing, setBearing] = useState(0);

  useEffect(() => mapService.subscribeBearing(setBearing), []);

  if (bearing === 0) return null;

  return (
    <button
      type="button"
      className="tc-locate-btn tc-north-btn"
      aria-label="Turn the map back to north up"
      title="North up"
      onClick={() => mapService.resetNorth()}
    >
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden style={{ transform: `rotate(${-bearing}deg)` }}>
        <path d="M12 3 16 12H8Z" fill="var(--tc-danger)" />
        <path d="M12 21 8 12h8Z" fill="currentColor" />
      </svg>
    </button>
  );
}
