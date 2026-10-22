import { useEffect, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  mapService,
  NAVIGATION_FOLLOW_ZOOM,
} from '../services/map.service';
import type { GpsFix } from '../types/navigation';
import type { Coordinate } from '../routing/routing-adapter';

interface MapViewProps {
  fix: GpsFix | null;
  followGps?: boolean;
  /** When true, show a heading arrow instead of the idle GPS dot. */
  navigating?: boolean;
  onMapClick?: (coordinate: Coordinate) => void;
  onRoutePick?: (index: number) => void;
  /** User panned/zoomed the map — stop auto-centering. */
  onFollowBreak?: () => void;
}

export function MapView({
  fix,
  followGps = true,
  navigating = false,
  onMapClick,
  onRoutePick,
  onFollowBreak,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const readyRef = useRef(false);
  const [status, setStatus] = useState(() => mapService.reportMapDataStatus());
  const onMapClickRef = useRef(onMapClick);
  const onRoutePickRef = useRef(onRoutePick);
  const onFollowBreakRef = useRef(onFollowBreak);

  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  useEffect(() => {
    onRoutePickRef.current = onRoutePick;
  }, [onRoutePick]);

  useEffect(() => {
    onFollowBreakRef.current = onFollowBreak;
  }, [onFollowBreak]);

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
    const unsubscribeCameraBreak = mapService.subscribeCameraBreak(() => {
      onFollowBreakRef.current?.();
    });
    mapService.initialize(el);
    readyRef.current = true;

    return () => {
      readyRef.current = false;
      unsubscribeStatus();
      unsubscribeClick();
      unsubscribeRoutePick();
      unsubscribeCameraBreak();
      mapService.dispose();
    };
  }, []);

  useEffect(() => {
    mapService.setPositionMode(navigating ? 'arrow' : 'dot');
  }, [navigating]);

  useEffect(() => {
    mapService.setFollowCamera(followGps);
  }, [followGps]);

  useEffect(() => {
    if (!readyRef.current || !fix) return;
    // Always move the marker; camera only follows when followGps is on.
    // While navigating, keep a fixed street-level zoom.
    mapService.showPosition([fix.longitude, fix.latitude], fix.headingDegrees, {
      follow: followGps,
      lockZoom:
        navigating && followGps ? NAVIGATION_FOLLOW_ZOOM : undefined,
    });
  }, [fix, followGps, navigating]);

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
