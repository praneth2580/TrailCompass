import { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { MapView } from '../components/MapView';
import { CompassWidget } from '../components/CompassWidget';
import { NavigationBanner } from '../components/NavigationBanner';
import { RouteOptionsPanel } from '../components/RouteOptionsPanel';
import { PlanScreen } from '../components/PlanScreen';
import { LibraryScreen } from '../components/LibraryScreen';
import { OfflineScreen } from '../components/OfflineScreen';
import {
  SaveShareRouteSheet,
  type SaveShareMode,
} from '../components/SaveShareRouteSheet';
import {
  StatusToast,
  type ToastTone,
} from '../components/StatusToast';
import type { RoutingProfileId } from '../routing/routing-profiles';
import {
  locationService,
  formatGpsChipLabel,
  isFixStale,
} from '../services/location.service';
import { compassService } from '../services/compass.service';
import { navigationService } from '../services/navigation.service';
import {
  mapService,
  type MapPoi,
  type PoiAction,
} from '../services/map.service';
import { routeLibrary } from '../services/route-library.service';
import { mapPackService, routePackId } from '../services/map-pack.service';
import { rideLogService, type LiveRide } from '../services/ride-log.service';
import type { RideRecord } from '../database/ride-repository';
import { RideSheet } from '../components/RideSheet';
import { formatClock } from '../routing/route-naming';
import type { LibraryTab } from '../components/LibraryScreen';
import { voiceGuidance } from '../services/voice-guidance.service';
import { checkForPoiUpdate } from '../services/poi-data.service';
import { checkForAppUpdate } from '../services/app-update.service';
import { backgroundPlanning } from '../services/background-planning.service';
import { downloadPolicy } from '../services/download-policy.service';
import { AppUpdateSheet } from '../components/AppUpdateSheet';
import {
  tripPlanner,
  type TripPlannerState,
} from '../services/trip-planner.service';
import {
  offlineRoutingAdapter,
  type OfflineEngineStatus,
} from '../routing/offline-adapter';
import type { CalculatedRoute, Coordinate } from '../routing/routing-adapter';
import type { CompassReading, GpsFix, NavigationState } from '../types/navigation';
import type { SavedPlaces, SavedRoute } from '../types/route';
import { createTripStop, type StopKind } from '../types/trip-stop';
import {
  setBrowserFullscreen,
  useRideFullscreen,
} from '../hooks/useRideFullscreen';
import { useKeepAwake } from '../hooks/useKeepAwake';
import { handleOverlayBack } from '../hooks/useBackHandler';
import { APP_ROUTES, type AppScreen } from './routes';

/** A second back press within this window leaves the app mid-navigation. */
const BACK_EXIT_WINDOW_MS = 2_500;
/** Let start-up finish before looking for newer fuel and food data. */
const POI_UPDATE_DELAY_MS = 10_000;
/** And for a newer app release, a little later still. */
const APP_UPDATE_DELAY_MS = 15_000;
/** Zen fade lengths; they match the zen animations in index.css. */
const ZEN_ENTER_MS = 180;
const ZEN_LEAVE_MS = 260;

/** Zen mode passes through a short fade on the way in and out. */
type ZenPhase = 'off' | 'entering' | 'on' | 'leaving';

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Map padding that frames the route clear of the zen compass: above it,
 * or beside it when that leaves more room (a phone in landscape).
 * offsetTop/Left give its resting place, unaffected by the rise animation.
 */
function zenRoutePadding(layer: HTMLElement | null) {
  const compass = layer?.querySelector<HTMLElement>('.tc-compass-zen');
  if (!layer || !compass) return { top: 80, right: 32, bottom: 260, left: 32 };
  const width = layer.clientWidth;
  const height = layer.clientHeight;
  const above = height - compass.offsetTop + 24;
  const beside = compass.offsetLeft + compass.offsetWidth + 24;
  const roomAbove = (width - 64) * (height - 80 - above);
  const roomBeside = (width - 32 - beside) * (height - 112);
  return roomBeside > roomAbove
    ? { top: 80, right: 32, bottom: 32, left: beside }
    : { top: 80, right: 32, bottom: above, left: 32 };
}

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('map');
  const [fix, setFix] = useState<GpsFix | null>(null);
  const [compass, setCompass] = useState<CompassReading | null>(null);
  const [locationError, setLocationError] = useState<string | undefined>();
  const [nav, setNav] = useState<NavigationState>(navigationService.getState());
  const [engine, setEngine] = useState<OfflineEngineStatus>(
    offlineRoutingAdapter.getStatus(),
  );
  const [now, setNow] = useState(() => Date.now());
  const [followGps, setFollowGps] = useState(true);
  /** Zen mode: only the map (with its route) and a large compass. */
  const [zenPhase, setZenPhase] = useState<ZenPhase>('off');
  const zenMode = zenPhase === 'entering' || zenPhase === 'on';
  const [libraryTick, setLibraryTick] = useState(0);
  const [toast, setToast] = useState<{
    message: string;
    tone: ToastTone;
  } | null>(null);
  const [sheetMode, setSheetMode] = useState<SaveShareMode | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetProgress, setSheetProgress] = useState<string | null>(null);
  /** The route whose map the share sheet is downloading, so Cancel can stop it. */
  const sheetMapRoute = useRef<string | null>(null);
  /**
   * One id per open share sheet, so trying again after dismissing the
   * system share sheet reuses the map already downloaded.
   */
  const shareRouteId = useRef<string | null>(null);
  const [itinerary, setItinerary] = useState<TripPlannerState>(
    tripPlanner.getState(),
  );
  const [planBusy, setPlanBusy] = useState(false);
  const [allowExpressways, setAllowExpressways] = useState(() =>
    navigationService.getAllowExpressways(),
  );
  const [voiceOn, setVoiceOn] = useState(() => voiceGuidance.isEnabled());
  const [overlaysOn, setOverlaysOn] = useState(() => mapService.overlaysOnMap());
  const [ride, setRide] = useState<LiveRide | null>(() => rideLogService.getLive());
  const [rideSheetOpen, setRideSheetOpen] = useState(false);
  const [rideBusy, setRideBusy] = useState(false);
  // Re-renders the ride clock each second while recording.
  const [, setRideTick] = useState(0);
  /** A past ride drawn on the map from Library. */
  const [viewedRide, setViewedRide] = useState<RideRecord | null>(null);
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('trips');
  const previewToken = useRef(0);
  const planTripKey = useRef<string | null>(null);
  const screenRef = useRef<AppScreen>(screen);
  const handleBackRef = useRef<() => void>(() => {});
  const handlePoiActionRef = useRef<(poi: MapPoi, action: PoiAction) => void>(() => {});
  const lastBackAt = useRef(0);
  const zenTimer = useRef<number | undefined>(undefined);
  const zenLayerRef = useRef<HTMLDivElement>(null);

  const { rideMode, dismissRideMode } = useRideFullscreen({
    status: nav.status,
    fix,
  });

  const navMode =
    nav.status === 'navigating' || nav.status === 'rerouting';
  useKeepAwake(navMode);
  const immersive = navMode || rideMode;
  const mapPickActive = itinerary.mapPick != null;
  const tripDestination = itinerary.destination?.coordinate ?? nav.destination ?? null;
  // Stops or destination edited after the route was planned.
  const routeOutdated =
    nav.status === 'choosing' &&
    !navigationService.isPlannedFor(
      tripDestination,
      itinerary.stops.map((stop) => stop.coordinate),
    );
  // The route the Plan tab suggests and orders stops along: only one that
  // leads to this trip's destination, so a route left from an earlier
  // destination is never used ("11 km trip, no fuel needed").
  const tripRoute = navigationService.isPlannedTo(tripDestination)
    ? navigationService.getActiveCalculatedRoute()
    : null;
  const canSaveRoute =
    ((nav.alternatives?.length ?? 0) > 0 || nav.status === 'navigating') &&
    (nav.status === 'choosing' ||
      nav.status === 'navigating' ||
      nav.status === 'rerouting');

  useEffect(() => {
    const unsubLoc = locationService.subscribe((next, error) => {
      setFix(next);
      setLocationError(error);
    });
    const unsubCompass = compassService.subscribe(setCompass);
    const unsubNav = navigationService.subscribe(setNav);
    const unsubVoice = navigationService.subscribe((state) =>
      voiceGuidance.update(state, locationService.getLastFix()?.speedMps ?? null),
    );
    const unsubEngine = offlineRoutingAdapter.subscribe(setEngine);
    const unsubTrip = tripPlanner.subscribe(setItinerary);
    const unsubMap = mapService.subscribeStatus((status) => {
      if (!status.ok) return;
      const { destination, stops } = tripPlanner.getState();
      mapService.setDestination(destination?.coordinate ?? null);
      mapService.setItineraryStops(
        stops.map((stop) => ({
          coordinate: stop.coordinate,
          kind: stop.kind,
          name: stop.name,
        })),
      );
      navigationService.redrawMap();
    });

    void locationService.startWatching();
    void compassService.start();
    void navigationService.ensureEngine();
    void downloadPolicy.start();
    // Every route plan gets its notification with Pause and Stop.
    const offAutoBackground = backgroundPlanning.watch();
    const offPoiAction = mapService.subscribePoiAction((poi, action) =>
      handlePoiActionRef.current(poi, action),
    );
    // The Offline tab's switches change the overlays too.
    const offOverlays = mapService.subscribeOverlays(() => setOverlaysOn(mapService.overlaysOnMap()));
    // A ride under way carries on (Android records with the app closed too).
    void rideLogService.init();
    const offRide = rideLogService.subscribe(() => setRide(rideLogService.getLive()));
    const offRideSaved = rideLogService.subscribeSaved((saved, reason) => {
      setRideSheetOpen(false);
      setToast(
        saved
          ? { message: `Saved “${saved.name}” · ${(saved.distanceMeters / 1000).toFixed(1)} km · in Library → Rides`, tone: 'success' }
          : { message: reason ?? 'Ride not saved', tone: 'error' },
      );
    });
    // Maps of deleted trips go at start-up, so Undo after a delete keeps the map.
    void routeLibrary
      .list()
      .then((routes) => mapPackService.pruneOrphans(routes.map((route) => route.id)))
      .catch(() => undefined);

    const tick = window.setInterval(() => setNow(Date.now()), 2000);
    // At most once a day; downloads quietly in the background.
    const poiUpdate = window.setTimeout(
      () => void checkForPoiUpdate(),
      POI_UPDATE_DELAY_MS,
    );
    // At most once a day; the prompt waits until no ride is in progress.
    const appUpdate = window.setTimeout(
      () => void checkForAppUpdate(),
      APP_UPDATE_DELAY_MS,
    );
    // Registering a listener replaces Android's default (leave the app).
    const backListener = CapacitorApp.addListener('backButton', () =>
      handleBackRef.current(),
    );

    return () => {
      unsubLoc();
      unsubCompass();
      unsubNav();
      unsubVoice();
      void backListener.then((listener) => listener.remove());
      unsubEngine();
      unsubTrip();
      unsubMap();
      offAutoBackground();
      offPoiAction();
      offOverlays();
      offRide();
      offRideSaved();
      window.clearInterval(tick);
      window.clearTimeout(poiUpdate);
      window.clearTimeout(appUpdate);
      void locationService.stopWatching();
      compassService.stop();
    };
  }, []);

  useEffect(() => {
    if (!fix) return;
    navigationService.updatePosition(
      [fix.longitude, fix.latitude],
      fix.accuracyMeters,
    );
  }, [fix]);

  useEffect(() => {
    // Browser fullscreen only once motion confirms a ride.
    void setBrowserFullscreen(rideMode && screen === 'map');
    return () => {
      void setBrowserFullscreen(false);
    };
  }, [rideMode, screen]);

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    const planningNow = planBusy || nav.status === 'planning';
    if (!planningNow || !planTripKey.current) return;
    const key = JSON.stringify({
      destination: itinerary.destination?.coordinate ?? null,
      waypoints: itinerary.stops.map((stop) => stop.coordinate),
      profile: nav.profile,
    });
    if (key === planTripKey.current) return;
    planTripKey.current = null;
    previewToken.current += 1;
    setPlanBusy(false);
    navigationService.cancelPlanning();
  }, [itinerary, nav.profile, nav.status, planBusy]);

  useEffect(() => {
    if (!toast || toast.tone === 'loading') return;
    const id = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(id);
  }, [toast]);

  const stale = fix ? isFixStale(fix, now) : false;
  const gpsTone = !fix || locationError ? 'missing' : stale ? 'stale' : 'ok';
  const canPlan = Boolean(nav.destination) && engine.ready;
  const showRouteOptions =
    Boolean(nav.destination) &&
    (nav.status === 'idle' ||
      nav.status === 'choosing' ||
      nav.status === 'error' ||
      nav.status === 'arrived') &&
    !navMode &&
    !mapPickActive;

  const resolveStart = (): Coordinate => {
    if (fix) return [fix.longitude, fix.latitude];
    const last = locationService.getLastFix();
    if (last) return [last.longitude, last.latitude];
    const center = mapService.getCenter();
    if (center) return center;
    throw new Error(
      'Need a GPS fix to start routing — open Map and wait for GPS, then try again',
    );
  };

  const resolveStartForPreview = async (): Promise<Coordinate> => {
    try {
      const gps = await locationService.ensureFix(8_000);
      return [gps.longitude, gps.latitude];
    } catch (e) {
      try {
        return resolveStart();
      } catch {
        throw e instanceof Error
          ? e
          : new Error('Need GPS to preview from Plan');
      }
    }
  };

  const readTripPlanKey = () =>
    JSON.stringify({
      destination: tripPlanner.getDestinationCoordinate(),
      waypoints: tripPlanner.getWaypoints(),
      profile: navigationService.getState().profile,
    });

  const syncItineraryMarkers = () => {
    const { destination, stops } = tripPlanner.getState();
    mapService.setDestination(destination?.coordinate ?? null);
    mapService.setItineraryStops(
      stops.map((s) => ({
        coordinate: s.coordinate,
        kind: s.kind,
        name: s.name,
      })),
    );
  };

  const handleMapClick = (coordinate: Coordinate, name?: string) => {
    // Zen mode is for looking around: taps never change the trip.
    if (zenMode) return;
    if (rideMode) {
      dismissRideMode();
      return;
    }
    if (navMode) return;

    if (tripPlanner.getState().mapPick) {
      const ok = tripPlanner.completeMapPick(coordinate, name);
      if (ok) {
        syncItineraryMarkers();
        setFollowGps(false);
        setScreen('plan');
        setToast({ message: 'Stop added to trip', tone: 'success' });
      }
      return;
    }

    setFollowGps(false);
    mapService.setDestination(coordinate);
    navigationService.setDestination(coordinate);
    tripPlanner.setDestinationFromCoordinate(coordinate, 'Map pin');
    mapService.clearItineraryStops();
  };

  const handlePoiAction = (poi: MapPoi, action: PoiAction) => {
    if (action === 'pick') {
      handleMapClick(poi.coordinate, poi.name);
      return;
    }
    if (action === 'stop') {
      tripPlanner.addStop(
        createTripStop(poi.kind, poi.coordinate, poi.name),
        tripRoute?.coordinates ?? null,
      );
      syncItineraryMarkers();
      setToast({ message: `Added “${poi.name}” as a stop`, tone: 'success' });
      return;
    }
    setFollowGps(false);
    mapService.setDestination(poi.coordinate);
    navigationService.setDestination(poi.coordinate);
    tripPlanner.setDestinationFromCoordinate(poi.coordinate, poi.name);
    mapService.clearItineraryStops();
    setToast({ message: `Going to “${poi.name}”`, tone: 'success' });
  };

  useEffect(() => {
    handlePoiActionRef.current = handlePoiAction;
  });

  // What a fuel or food popup offers: nothing mid-ride or in zen mode.
  const hasDestination = itinerary.destination != null;
  useEffect(() => {
    let actions: PoiAction[];
    if (navMode || zenMode || rideMode) actions = [];
    else if (mapPickActive) actions = ['pick'];
    else if (hasDestination) actions = ['destination', 'stop'];
    else actions = ['destination'];
    mapService.setPoiActions(actions);
  }, [navMode, zenMode, rideMode, mapPickActive, hasDestination]);

  const handlePlanRoute = () => {
    const end =
      tripPlanner.getDestinationCoordinate() ?? nav.destination ?? null;
    if (!end) return;
    const waypoints = tripPlanner.getWaypoints();
    syncItineraryMarkers();
    planTripKey.current = readTripPlanKey();
    try {
      void navigationService.planRoute(resolveStart(), end, waypoints);
    } catch (e) {
      setToast({
        message: e instanceof Error ? e.message : 'Could not plan route',
        tone: 'error',
      });
    }
  };

  /**
   * Plan the Plan-tab itinerary from GPS. With `showMap` the rider is taken
   * to the map and errors are toasted; without it, the Plan tab stays put and
   * errors are thrown so the caller (e.g. stop suggestions) can show them.
   * Resolves to null when superseded or cancelled.
   */
  const planTripFromItinerary = async ({
    showMap,
  }: {
    showMap: boolean;
  }): Promise<CalculatedRoute | null> => {
    const end = tripPlanner.getDestinationCoordinate();
    if (!end) {
      const message = 'Set a destination on Plan first';
      if (!showMap) throw new Error(message);
      setToast({ message, tone: 'error' });
      return null;
    }
    const waypoints = tripPlanner.getWaypoints();
    const token = ++previewToken.current;
    planTripKey.current = readTripPlanKey();
    setPlanBusy(true);
    syncItineraryMarkers();
    navigationService.setDestination(end);
    navigationService.setWaypoints(waypoints);
    navigationService.cancelPlanning();
    navigationService.showPlanning('Getting GPS…');
    if (showMap) {
      setScreen('map');
      setFollowGps(true);
    }

    let failure: string | null = null;
    try {
      const start = await resolveStartForPreview();
      if (token !== previewToken.current) return null;
      mapService.centerOn(start);
      const result = await navigationService.planRoute(start, end, waypoints);
      if (token !== previewToken.current || result === 'cancelled') return null;
      if (result === 'error') {
        failure = navigationService.getState().message ?? 'Could not plan trip';
      } else {
        if (showMap) {
          setToast({
            message:
              waypoints.length > 0
                ? `Route ready · ${waypoints.length} stop${waypoints.length === 1 ? '' : 's'}`
                : 'Route ready — tap Start',
            tone: 'success',
          });
        }
        return navigationService.getActiveCalculatedRoute();
      }
    } catch (e) {
      if (token !== previewToken.current) return null;
      navigationService.cancelPlanning();
      failure = e instanceof Error ? e.message : 'Could not plan trip';
    } finally {
      if (token === previewToken.current) setPlanBusy(false);
    }

    const message = failure ?? 'Could not plan trip';
    if (!showMap) throw new Error(message);
    setToast({ message, tone: 'error' });
    if (screenRef.current === 'map') setScreen('plan');
    return null;
  };

  const handlePreviewFromPlan = () => {
    void planTripFromItinerary({ showMap: true });
  };

  const handleClearTrip = () => {
    previewToken.current += 1;
    planTripKey.current = null;
    setPlanBusy(false);
    tripPlanner.clear();
    navigationService.clearItinerary();
  };

  const handleRequestMapPick = (
    kind: StopKind,
    mode: 'destination' | 'stop',
  ) => {
    tripPlanner.beginMapPick({ kind, mode });
    setScreen('map');
    setFollowGps(false);
    setToast({
      message: 'Tap the map once to place the stop',
      tone: 'loading',
    });
  };

  const handleStartNavigation = (index?: number) => {
    if (routeOutdated) {
      setToast({
        message: 'Trip changed — plan the route again first',
        tone: 'error',
      });
      return;
    }
    navigationService.startNavigation(index);
    setFollowGps(true);
    if (fix) {
      mapService.resumeNavigationFollow(
        [fix.longitude, fix.latitude],
        fix.headingDegrees,
      );
    }
  };

  const handleRecenterNavigation = () => {
    if (!fix) {
      void locationService.startWatching();
      return;
    }
    setFollowGps(true);
    mapService.resumeNavigationFollow(
      [fix.longitude, fix.latitude],
      fix.headingDegrees,
    );
  };

  const replanAfterOptionChange = () => {
    const end =
      tripPlanner.getDestinationCoordinate() ?? nav.destination ?? null;
    if (
      end &&
      (nav.status === 'choosing' ||
        nav.status === 'error' ||
        nav.status === 'idle')
    ) {
      planTripKey.current = readTripPlanKey();
      try {
        void navigationService.planRoute(
          resolveStart(),
          end,
          tripPlanner.getWaypoints(),
        );
      } catch (e) {
        setToast({
          message: e instanceof Error ? e.message : 'Could not replan',
          tone: 'error',
        });
      }
    }
  };

  const handleProfileChange = (profile: RoutingProfileId) => {
    navigationService.setProfile(profile);
    replanAfterOptionChange();
  };

  const handleAllowExpresswaysChange = (allow: boolean) => {
    navigationService.setAllowExpressways(allow);
    setAllowExpressways(allow);
    replanAfterOptionChange();
  };

  const handleGoToMyLocation = () => {
    if (!fix) {
      void locationService.startWatching();
      return;
    }
    setFollowGps(true);
    mapService.centerOn([fix.longitude, fix.latitude]);
  };

  // The notification is usually up already; this sends the app away.
  const canRunInBackground =
    backgroundPlanning.isAvailable() && navigationService.isPlanningRoute();

  /** Notification with progress, Pause and Stop; the app goes to the background. */
  const handleRunInBackground = () => {
    void backgroundPlanning.start().then((started) => {
      if (!started && navigationService.isPlanningRoute()) {
        setToast({ message: "Couldn't continue in the background", tone: 'error' });
      }
    });
  };

  const handleStop = () => {
    dismissRideMode();
    void setBrowserFullscreen(false);
    navigationService.stop();
  };

  const handleVoiceGuidanceChange = (enabled: boolean) => {
    voiceGuidance.setEnabled(enabled);
    setVoiceOn(enabled);
  };

  /** Shows `phase` now, then `settled` once its fade has played. */
  const stepZen = (phase: ZenPhase, settled: ZenPhase, ms: number) => {
    window.clearTimeout(zenTimer.current);
    setZenPhase(phase);
    zenTimer.current = window.setTimeout(
      () => setZenPhase(settled),
      prefersReducedMotion() ? 0 : ms,
    );
  };

  useEffect(() => () => window.clearTimeout(zenTimer.current), []);

  const closeZenMode = () => stepZen('leaving', 'off', ZEN_LEAVE_MS);

  /**
   * Android back: close the open sheet, then leave map-pick or ride view,
   * then return to the Map tab. Mid-navigation, leaving needs a second press.
   */
  const handleBack = () => {
    if (handleOverlayBack()) return;
    if (zenMode) {
      closeZenMode();
      return;
    }
    if (tripPlanner.getState().mapPick) {
      tripPlanner.cancelMapPick();
      setScreen('plan');
      setToast(null);
      return;
    }
    if (rideMode) {
      dismissRideMode();
      return;
    }
    if (screen !== 'map') {
      setScreen('map');
      return;
    }
    if (navMode) {
      const pressedAt = Date.now();
      if (pressedAt - lastBackAt.current > BACK_EXIT_WINDOW_MS) {
        lastBackAt.current = pressedAt;
        setToast({
          message: 'Navigation is running — press back again to leave',
          tone: 'info',
        });
        return;
      }
    }
    // Background rather than exit, so the trip and route survive.
    void CapacitorApp.minimizeApp();
  };

  useEffect(() => {
    handleBackRef.current = handleBack;
  });

  const openZenMode = () => {
    stepZen('entering', 'on', ZEN_ENTER_MS);
    const route = navigationService.getActiveCalculatedRoute();
    // While navigating, the camera keeps following the rider.
    if (!route || navMode) return;
    setFollowGps(false);
    // Two frames: let the map grow into the space the hidden bars leave,
    // then frame the route clear of the compass.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        mapService.fitRoute(route.coordinates, zenRoutePadding(zenLayerRef.current)),
      ),
    );
  };

  useEffect(() => {
    if (ride?.state !== 'recording') return;
    const timer = window.setInterval(() => setRideTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [ride?.state]);

  const handleRecordButton = async () => {
    if (ride) {
      setRideSheetOpen(true);
      return;
    }
    try {
      await rideLogService.start();
      setToast({ message: 'Recording your ride', tone: 'success' });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Couldn't start recording", tone: 'error' });
    }
  };

  const runRide = async (work: () => Promise<unknown>) => {
    setRideBusy(true);
    try {
      await work();
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : 'Something went wrong', tone: 'error' });
    } finally {
      setRideBusy(false);
    }
  };

  const handleShowRide = (picked: RideRecord) => {
    setViewedRide(picked);
    setFollowGps(false);
    setScreen('map');
    // After the map is on screen, so it frames the ride at its real size.
    window.setTimeout(() => void rideLogService.showOnMap(picked), 80);
  };

  const hideViewedRide = () => {
    rideLogService.hideFromMap();
    setViewedRide(null);
  };

  const openSaveShareSheet = (mode: SaveShareMode) => {
    if (!navigationService.getActiveCalculatedRoute()) {
      setToast({ message: 'No route to save yet', tone: 'error' });
      return;
    }
    setSheetError(null);
    setSheetBusy(false);
    shareRouteId.current = crypto.randomUUID();
    setSheetMode(mode);
  };

  /** The map fetched only for sharing isn't kept once the sheet closes. */
  const closeSheet = () => {
    setSheetMode(null);
    setSheetError(null);
    const id = shareRouteId.current;
    shareRouteId.current = null;
    if (id) void mapPackService.deleteForRoute(id).catch(() => undefined);
  };

  /** The trip's names, when the route being saved was planned for it. */
  const tripPlaces = (): SavedPlaces | undefined => {
    const { destination, stops } = tripPlanner.getState();
    if (
      !destination ||
      !navigationService.isPlannedFor(
        destination.coordinate,
        stops.map((stop) => stop.coordinate),
      )
    ) {
      return undefined;
    }
    return {
      end: destination.name,
      ...(destination.notes ? { endNotes: destination.notes } : {}),
      stops: stops.map((stop) => ({
        name: stop.name,
        kind: stop.kind === 'destination' ? 'manual' : stop.kind,
        ...(stop.notes ? { notes: stop.notes } : {}),
      })),
    };
  };

  const handleSheetConfirm = async (name: string, withMap: boolean) => {
    if (!sheetMode) return;
    setSheetBusy(true);
    setSheetError(null);
    setSheetProgress(null);
    try {
      if (sheetMode === 'save') {
        setToast({ message: 'Saving route…', tone: 'loading' });
        const saved = await navigationService.saveActiveRoute(name, tripPlaces());
        // The map downloads in the background; Library shows its progress.
        if (withMap) void mapPackService.downloadRoute(saved).catch(() => undefined);
        setLibraryTick((n) => n + 1);
        closeSheet();
        setScreen('library');
        setToast({
          message: withMap
            ? `Saved “${saved.name}” · saving its map`
            : `Saved “${saved.name}”`,
          tone: 'success',
        });
      } else {
        setToast({ message: 'Preparing share file…', tone: 'loading' });
        const built = navigationService.buildSavedSnapshot(name, tripPlaces());
        if (!built) throw new Error('No route to share');
        const snapshot = { ...built, id: shareRouteId.current ?? built.id };
        const pack = mapPackService.packForRoute(snapshot.id);
        if (
          withMap &&
          (!pack || pack.saved < pack.tiles) &&
          !(await downloadSheetMap(snapshot))
        ) {
          // Cancelled: back to the sheet as it was.
          setToast(null);
          return;
        }
        const shared = await routeLibrary.exportAndShare(
          snapshot,
          'trailcompass',
          { withMap },
        );
        if (!shared) {
          // Dismissed the system share sheet: stay on ours, no error.
          setToast(null);
          return;
        }
        closeSheet();
        setToast({
          message: `Ready to share “${snapshot.name}”`,
          tone: 'success',
        });
      }
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'Something went wrong';
      setSheetError(message);
      setToast({ message, tone: 'error' });
    } finally {
      setSheetBusy(false);
      setSheetProgress(null);
    }
  };

  /** Downloads the map for a route about to be shared; false when cancelled. */
  const downloadSheetMap = async (route: SavedRoute): Promise<boolean> => {
    sheetMapRoute.current = route.id;
    const off = mapPackService.subscribe(() => {
      const job = mapPackService.getJob(routePackId(route.id));
      if (job?.state === 'waiting-wifi') setSheetProgress('Waiting for Wi-Fi…');
      if (job?.state === 'downloading' && job.total > 0) {
        setSheetProgress(`Map ${Math.round((job.done / job.total) * 100)}%`);
      }
    });
    setToast({ message: 'Downloading the map along the route…', tone: 'loading' });
    try {
      return (await mapPackService.downloadRoute(route)) != null;
    } finally {
      off();
      sheetMapRoute.current = null;
    }
  };

  const handleOpenSavedRoute = (route: SavedRoute) => {
    tripPlanner.loadFromSaved(route.end, route.waypoints ?? [], route.places);
    navigationService.loadSavedRoute(route);
    setFollowGps(true);
    setScreen('map');
    setToast({
      message: `Loaded “${route.name}” — tap Start`,
      tone: 'success',
    });
  };

  const gpsCoordinate: Coordinate | null = fix
    ? [fix.longitude, fix.latitude]
    : null;

  return (
    <div
      className="tc-app"
      data-screen={screen}
      data-nav={navMode ? 'true' : undefined}
      data-ride={rideMode ? 'true' : undefined}
      data-map-pick={mapPickActive ? 'true' : undefined}
      data-zen={zenPhase === 'off' ? undefined : zenPhase}
    >
      {/* Always mounted so switching tabs does not reload the map. */}
      <main
        className="tc-main tc-main-map"
        data-hidden={screen !== 'map' ? 'true' : undefined}
        inert={screen !== 'map'}
      >
        <MapView
          fix={fix}
          visible={screen === 'map'}
          followGps={followGps}
          navigating={navMode}
          onMapClick={handleMapClick}
          onFollowBreak={() => setFollowGps(false)}
          onRoutePick={(index) => {
            if (navMode || zenMode) return;
            navigationService.selectAlternative(index);
          }}
        />

        {mapPickActive ? (
          <div className="tc-map-pick-banner" role="status">
            <p>Tap once to place your stop</p>
            <button
              type="button"
              className="tc-btn tc-btn-secondary"
              onClick={() => {
                tripPlanner.cancelMapPick();
                setScreen('plan');
                setToast(null);
              }}
            >
              Cancel
            </button>
          </div>
        ) : null}

        {navMode && !followGps ? (
          <button
            type="button"
            className="tc-recenter-btn"
            onClick={handleRecenterNavigation}
            disabled={!fix}
            aria-label="Recenter on my location"
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              aria-hidden
            >
              <path
                d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle
                cx="12"
                cy="12"
                r="7"
                stroke="currentColor"
                strokeWidth="2"
              />
              <circle cx="12" cy="12" r="2.75" fill="currentColor" />
            </svg>
            <span>Recenter</span>
          </button>
        ) : !immersive ? (
          <button
            type="button"
            className="tc-locate-btn"
            onClick={handleGoToMyLocation}
            disabled={!fix}
            aria-label="Go to my location"
            title={fix ? 'Go to my location' : 'Waiting for GPS…'}
          >
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              aria-hidden
            >
              <path
                d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle
                cx="12"
                cy="12"
                r="7"
                stroke="currentColor"
                strokeWidth="2"
              />
              <circle cx="12" cy="12" r="2.75" fill="currentColor" />
            </svg>
          </button>
        ) : null}

        {!zenMode ? (
          <button
            type="button"
            className="tc-locate-btn tc-poi-btn"
            aria-pressed={overlaysOn}
            aria-label={overlaysOn ? 'Hide map overlays' : 'Show map overlays'}
            title="Map overlays"
            onClick={() => mapService.setOverlaysShown(!overlaysOn)}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
              <path
                d="M12 3 2.5 8 12 13l9.5-5L12 3ZM2.5 12 12 17l9.5-5M2.5 16 12 21l9.5-5"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}

        {!zenMode ? (
          <button
            type="button"
            className="tc-locate-btn tc-rec-btn"
            data-state={ride?.state ?? 'idle'}
            aria-label={ride ? 'Ride recording: open controls' : 'Record a ride'}
            title={ride ? 'Ride recording' : 'Record ride'}
            onClick={() => void handleRecordButton()}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.9" />
              <circle className="tc-rec-btn-dot" cx="12" cy="12" r="4.2" fill="currentColor" />
            </svg>
          </button>
        ) : null}

        <aside className="tc-hud" aria-label="Status">
          <div
            className={`tc-gps-chip tc-gps-chip-${gpsTone}`}
            role="status"
            title={locationError ?? undefined}
          >
            <span className="tc-gps-chip-dot" aria-hidden />
            <span className="tc-gps-chip-label">GPS</span>
            <span className="tc-gps-chip-value">
              {formatGpsChipLabel(fix, locationError, { stale })}
            </span>
            {fix?.speedMps != null && fix.speedMps >= 0 ? (
              <span className="tc-gps-chip-speed">
                {formatSpeedKmh(fix.speedMps)}
              </span>
            ) : null}
          </div>
          <CompassWidget
            reading={compass}
            onEnable={() => void compassService.start()}
            onOpen={mapPickActive ? undefined : openZenMode}
          />
          {ride ? (
            <button type="button" className="tc-rec-chip" data-state={ride.state} onClick={() => setRideSheetOpen(true)}>
              <span className="tc-rec-dot" data-state={ride.state} aria-hidden />
              <span className="tc-rec-chip-label">{ride.state === 'recording' ? 'REC' : 'PAUSED'}</span>
              <span className="tc-rec-chip-value">
                {(ride.distanceMeters / 1000).toFixed(1)} km · {formatClock(rideLogService.activeSeconds())}
              </span>
            </button>
          ) : null}
          {viewedRide ? (
            <div className="tc-ride-view-chip" role="status">
              <span>{viewedRide.name} · {(viewedRide.distanceMeters / 1000).toFixed(1)} km</span>
              <button type="button" aria-label="Hide this ride" onClick={hideViewedRide}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
                  <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ) : null}
        </aside>

        {zenPhase !== 'off' ? (
          <div className="tc-zen" ref={zenLayerRef} inert={zenPhase === 'leaving'}>
            <button
              type="button"
              className="tc-zen-exit"
              onClick={closeZenMode}
              aria-label="Exit zen mode"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
                <path
                  d="M6 6l12 12M18 6 6 18"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
              Exit
            </button>
            <CompassWidget
              reading={compass}
              onEnable={() => void compassService.start()}
              variant="zen"
            />
          </div>
        ) : null}

        {!mapPickActive ? (
          <div className="tc-map-dock">
            <RouteOptionsPanel
              visible={showRouteOptions}
              profile={nav.profile ?? 'fastest'}
              alternatives={routeOutdated ? [] : (nav.alternatives ?? [])}
              selectedIndex={nav.selectedAlternativeIndex ?? 0}
              showAllRoutes={nav.showAllRoutes === true}
              onProfileChange={handleProfileChange}
              allowExpressways={allowExpressways}
              onAllowExpresswaysChange={handleAllowExpresswaysChange}
              voiceGuidance={voiceOn}
              onVoiceGuidanceChange={handleVoiceGuidanceChange}
              onSelectAlternative={(index) =>
                navigationService.selectAlternative(index)
              }
              onStartNavigation={handleStartNavigation}
              onToggleShowAll={(showAll) =>
                navigationService.setShowAllRoutes(showAll)
              }
            />

            <NavigationBanner
              state={nav}
              canPlan={canPlan}
              navMode={navMode}
              rideMode={rideMode}
              canSaveRoute={canSaveRoute}
              routeOutdated={routeOutdated}
              onPlan={handlePlanRoute}
              onRunInBackground={canRunInBackground ? handleRunInBackground : undefined}
              onStart={() => handleStartNavigation()}
              onStop={handleStop}
              onExitRide={dismissRideMode}
              onSaveRoute={() => openSaveShareSheet('save')}
              onShareRoute={() => openSaveShareSheet('share')}
            />
          </div>
        ) : null}

        <RideSheet
          ride={ride}
          open={rideSheetOpen}
          seconds={rideLogService.activeSeconds()}
          busy={rideBusy}
          onClose={() => setRideSheetOpen(false)}
          onPause={() => void runRide(() => rideLogService.pause())}
          onResume={() => void runRide(() => rideLogService.resume())}
          onFinish={() => void runRide(() => rideLogService.finish())}
          onDiscard={() =>
            void runRide(async () => {
              await rideLogService.discard();
              setRideSheetOpen(false);
              setToast({ message: 'Ride discarded', tone: 'success' });
            })
          }
        />

        <SaveShareRouteSheet
          open={sheetMode != null}
          mode={sheetMode ?? 'save'}
          route={navigationService.getActiveCalculatedRoute()}
          profile={nav.profile}
          busy={sheetBusy}
          progress={sheetProgress}
          error={sheetError}
          onClose={() => {
            if (!sheetBusy) closeSheet();
          }}
          onConfirm={(name, withMap) => void handleSheetConfirm(name, withMap)}
          onCancelBusy={
            sheetProgress
              ? () => {
                  if (sheetMapRoute.current) mapPackService.cancel(routePackId(sheetMapRoute.current));
                }
              : undefined
          }
        />

        {toast && screen === 'map' ? (
          <StatusToast message={toast.message} tone={toast.tone} />
        ) : null}
      </main>

      {screen === 'plan' ? (
        <div className="tc-plan-shell">
          <PlanScreen
            gpsCoordinate={gpsCoordinate}
            nav={nav}
            activeRoute={tripRoute}
            engineReady={engine.ready}
            planning={planBusy || nav.status === 'planning'}
            routeOutdated={routeOutdated}
            onPreview={handlePreviewFromPlan}
            onShowMap={() => {
              setScreen('map');
              // Mid-ride the camera follows the rider; while planning there
              // is no new route yet to frame.
              if (navMode) {
                setFollowGps(true);
                return;
              }
              const route = navigationService.getActiveCalculatedRoute();
              if (!route || nav.status === 'planning') return;
              setFollowGps(false);
              mapService.fitRoute(route.coordinates);
            }}
            onRunInBackground={canRunInBackground ? handleRunInBackground : undefined}
            onPlanInPlace={() => planTripFromItinerary({ showMap: false })}
            onStart={() => {
              handleStartNavigation();
              setScreen('map');
            }}
            onRequestMapPick={handleRequestMapPick}
            onClear={handleClearTrip}
          />
          {toast ? (
            <StatusToast message={toast.message} tone={toast.tone} />
          ) : null}
        </div>
      ) : screen === 'library' ? (
        <div className="tc-plan-shell">
          <LibraryScreen
            refreshKey={libraryTick}
            onOpenRoute={handleOpenSavedRoute}
            onPlanTrip={() => setScreen('plan')}
            onShowRide={handleShowRide}
            tab={libraryTab}
            onTabChange={setLibraryTab}
          />
          {toast ? (
            <StatusToast message={toast.message} tone={toast.tone} />
          ) : null}
        </div>
      ) : screen === 'downloads' ? (
        <OfflineScreen engine={engine} />
      ) : null}

      {/* Never interrupt turn-by-turn or zen mode; it appears afterwards. */}
      {!navMode && !zenMode ? <AppUpdateSheet /> : null}

      <nav className="tc-bottom-nav" aria-label="Main">
        {APP_ROUTES.map((route) => (
          <button
            key={route.id}
            type="button"
            className={
              screen === route.id
                ? 'tc-nav-item tc-nav-item-active'
                : 'tc-nav-item'
            }
            onClick={() => {
              if (mapPickActive && route.id !== 'map') {
                tripPlanner.cancelMapPick();
              }
              setScreen(route.id);
            }}
            aria-current={screen === route.id ? 'page' : undefined}
          >
            <span className="tc-nav-icon" aria-hidden>
              <NavIcon id={route.id} />
            </span>
            <span className="tc-nav-label">{route.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function NavIcon({ id }: { id: AppScreen }) {
  if (id === 'map') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
        <path
          d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20V6.5Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M9 4v13.5M15 6.5V20"
          stroke="currentColor"
          strokeWidth="2"
        />
      </svg>
    );
  }
  if (id === 'plan') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
        <path
          d="M8 6h12M8 12h12M8 18h12"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="4.5" cy="6" r="1.5" fill="currentColor" />
        <circle cx="4.5" cy="12" r="1.5" fill="currentColor" />
        <circle cx="4.5" cy="18" r="1.5" fill="currentColor" />
      </svg>
    );
  }
  if (id === 'library') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
        <path
          d="M5 4.5h5.5v15H5a1.5 1.5 0 0 1-1.5-1.5v-12A1.5 1.5 0 0 1 5 4.5Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M10.5 4.5H19a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-8.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M10.5 4.5v15"
          stroke="currentColor"
          strokeWidth="2"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
      <path
        d="M12 3v12M8 11l4 4 4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 17.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function formatSpeedKmh(mps: number): string {
  return `${Math.round(mps * 3.6)} km/h`;
}
