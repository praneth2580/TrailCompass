import { useEffect, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapService } from '../services/map.service';
import { riderHeadingDegrees } from '../services/nav-display';
import type { GpsFix, NavigationState } from '../types/navigation';
import type { Coordinate } from '../routing/routing-adapter';

interface MapViewProps {
  fix: GpsFix | null;
  /** False while another tab is shown; the map stays mounted behind it. */
  visible?: boolean;
  followGps?: boolean;
  /**
   * When true, show a heading arrow instead of the idle GPS dot, and turn
   * and tilt the camera with the rider.
   */
  navigating?: boolean;
  /** The rider's spot on the route while navigating on it: drawn instead of the raw fix. */
  routeMatch?: NavigationState['matched'];
  onMapClick?: (coordinate: Coordinate) => void;
  onRoutePick?: (index: number) => void;
  /** User panned/zoomed the map — stop auto-centering. */
  onFollowBreak?: () => void;
}

export function MapView({
  fix,
  visible = true,
  followGps = true,
  navigating = false,
  routeMatch,
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
    mapService.setVisible(visible);
  }, [visible]);

  useEffect(() => {
    if (!readyRef.current || !fix) return;
    // Always move the marker; the camera only follows when followGps is on.
    // On the route the rider is drawn on the road, pointing along it.
    const match = navigating ? routeMatch : undefined;
    mapService.showPosition(
      match?.coordinate ?? [fix.longitude, fix.latitude],
      riderHeadingDegrees({
        courseDegrees: fix.headingDegrees,
        speedMps: fix.speedMps,
        routeBearingDegrees: match?.bearingDegrees,
      }),
      { speedMps: fix.speedMps },
    );
  }, [fix, navigating, routeMatch]);

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
