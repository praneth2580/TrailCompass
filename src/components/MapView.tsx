import { useEffect, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapService } from '../services/map.service';
import type { GpsFix } from '../types/navigation';
import type { Coordinate } from '../routing/routing-adapter';

interface MapViewProps {
  fix: GpsFix | null;
  followGps?: boolean;
  onMapClick?: (coordinate: Coordinate) => void;
}

export function MapView({
  fix,
  followGps = true,
  onMapClick,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const readyRef = useRef(false);
  const [status, setStatus] = useState(() => mapService.reportMapDataStatus());
  const onMapClickRef = useRef(onMapClick);

  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const unsubscribeStatus = mapService.subscribeStatus(setStatus);
    const unsubscribeClick = mapService.subscribeClick((coordinate) => {
      onMapClickRef.current?.(coordinate);
    });
    mapService.initialize(el);
    readyRef.current = true;

    return () => {
      readyRef.current = false;
      unsubscribeStatus();
      unsubscribeClick();
      mapService.dispose();
    };
  }, []);

  useEffect(() => {
    if (!readyRef.current || !fix || !followGps) return;
    mapService.showPosition([fix.longitude, fix.latitude], fix.headingDegrees);
  }, [fix, followGps]);

  const showBadge = !status.ok;

  return (
    <div className="tc-map-shell">
      <div
        ref={containerRef}
        className="tc-map-container"
        role="application"
        aria-label="TrailCompass map"
        title={status.message}
      />
      <p
        className="tc-map-badge"
        data-visible={showBadge ? 'true' : 'false'}
        role="status"
      >
        {status.message}
      </p>
    </div>
  );
}
