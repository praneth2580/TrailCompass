import { useEffect, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapService } from '../services/map.service';
import type { GpsFix } from '../types/navigation';
import type { Coordinate } from '../routing/routing-adapter';

interface MapViewProps {
  fix: GpsFix | null;
  followGps?: boolean;
  onMapClick?: (coordinate: Coordinate) => void;
  onRoutePick?: (index: number) => void;
}

export function MapView({
  fix,
  followGps = true,
  onMapClick,
  onRoutePick,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const readyRef = useRef(false);
  const [status, setStatus] = useState(() => mapService.reportMapDataStatus());
  const onMapClickRef = useRef(onMapClick);
  const onRoutePickRef = useRef(onRoutePick);

  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  useEffect(() => {
    onRoutePickRef.current = onRoutePick;
  }, [onRoutePick]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const unsubscribeStatus = mapService.subscribeStatus(setStatus);
    const unsubscribeClick = mapService.subscribeClick((coordinate) => {
      onMapClickRef.current?.(coordinate);
    });
    const unsubscribeRoutePick = mapService.subscribeRoutePick((index) => {
      onRoutePickRef.current?.(index);
    });
    mapService.initialize(el);
    readyRef.current = true;

    return () => {
      readyRef.current = false;
      unsubscribeStatus();
      unsubscribeClick();
      unsubscribeRoutePick();
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
