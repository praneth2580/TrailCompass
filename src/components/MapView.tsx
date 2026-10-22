import { useEffect, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapService } from '../services/map.service';
import type { GpsFix } from '../types/navigation';

interface MapViewProps {
  fix: GpsFix | null;
  followGps?: boolean;
}

export function MapView({ fix, followGps = true }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const readyRef = useRef(false);
  const [statusNote, setStatusNote] = useState(
    () => mapService.reportMapDataStatus().message,
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const unsubscribe = mapService.subscribeStatus((status) => {
      setStatusNote(status.message);
    });
    mapService.initialize(el);
    readyRef.current = true;

    return () => {
      readyRef.current = false;
      unsubscribe();
      mapService.dispose();
    };
  }, []);

  useEffect(() => {
    if (!readyRef.current || !fix || !followGps) return;
    mapService.showPosition([fix.longitude, fix.latitude], fix.headingDegrees);
  }, [fix, followGps]);

  return (
    <div className="tc-map-shell">
      <div
        ref={containerRef}
        className="tc-map-container"
        role="application"
        aria-label="TrailCompass map"
      />
      <p className="tc-map-badge" title={statusNote}>
        {statusNote}
      </p>
    </div>
  );
}
