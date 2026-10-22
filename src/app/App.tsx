import { useEffect, useState } from 'react';
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
import { mapService } from '../services/map.service';
import { routeLibrary } from '../services/route-library.service';
import {
  tripPlanner,
  type TripPlannerState,
} from '../services/trip-planner.service';
import {
  offlineRoutingAdapter,
  type OfflineEngineStatus,
} from '../routing/offline-adapter';
import type { Coordinate } from '../routing/routing-adapter';
import type { CompassReading, GpsFix, NavigationState } from '../types/navigation';
import type { SavedRoute } from '../types/route';
import type { StopKind } from '../types/trip-stop';
import {
  setBrowserFullscreen,
  useRideFullscreen,
} from '../hooks/useRideFullscreen';
import { APP_ROUTES, type AppScreen } from './routes';

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
  const [libraryTick, setLibraryTick] = useState(0);
  const [toast, setToast] = useState<{
    message: string;
    tone: ToastTone;
  } | null>(null);
  const [sheetMode, setSheetMode] = useState<SaveShareMode | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [itinerary, setItinerary] = useState<TripPlannerState>(
    tripPlanner.getState(),
  );
  const [planBusy, setPlanBusy] = useState(false);

  const { rideMode, dismissRideMode } = useRideFullscreen({
    status: nav.status,
    fix,
  });

  const navMode =
    nav.status === 'navigating' || nav.status === 'rerouting';
  const immersive = navMode || rideMode;
  const mapPickActive = itinerary.mapPick != null;
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
    const unsubEngine = offlineRoutingAdapter.subscribe(setEngine);
    const unsubTrip = tripPlanner.subscribe(setItinerary);

    void locationService.startWatching();
    void compassService.start();
    void navigationService.ensureEngine();

    const tick = window.setInterval(() => setNow(Date.now()), 2000);

    return () => {
      unsubLoc();
      unsubCompass();
      unsubNav();
      unsubEngine();
      unsubTrip();
      window.clearInterval(tick);
      void locationService.stopWatching();
      compassService.stop();
    };
  }, []);

  useEffect(() => {
    if (!fix) return;
    navigationService.updatePosition([fix.longitude, fix.latitude]);
  }, [fix]);

  useEffect(() => {
    // Browser fullscreen only once motion confirms a ride.
    void setBrowserFullscreen(rideMode && screen === 'map');
    return () => {
      void setBrowserFullscreen(false);
    };
  }, [rideMode, screen]);

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
    const center = mapService.getCenter();
    if (center) return center;
    if (nav.destination) {
      return [nav.destination[0] - 0.01, nav.destination[1] - 0.01];
    }
    return [0, 0];
  };

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

  const handleMapClick = (coordinate: Coordinate) => {
    if (rideMode) {
      dismissRideMode();
      return;
    }
    if (navMode) return;

    if (tripPlanner.getState().mapPick) {
      const ok = tripPlanner.completeMapPick(coordinate);
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

  const handlePlanRoute = () => {
    const end =
      tripPlanner.getDestinationCoordinate() ?? nav.destination ?? null;
    if (!end) return;
    const waypoints = tripPlanner.getWaypoints();
    syncItineraryMarkers();
    void navigationService.planRoute(resolveStart(), end, waypoints);
  };

  const handlePreviewFromPlan = () => {
    const end = tripPlanner.getDestinationCoordinate();
    if (!end) return;
    const waypoints = tripPlanner.getWaypoints();
    setPlanBusy(true);
    syncItineraryMarkers();
    setScreen('map');
    setFollowGps(false);
    setToast({ message: 'Planning trip…', tone: 'loading' });
    void navigationService
      .planRoute(resolveStart(), end, waypoints)
      .then(() => {
        const state = navigationService.getState();
        if (state.status === 'error') {
          setToast({
            message: state.message ?? 'Could not plan trip',
            tone: 'error',
          });
          setScreen('plan');
          return;
        }
        setToast({
          message:
            waypoints.length > 0
              ? `Route ready · ${waypoints.length} stop${waypoints.length === 1 ? '' : 's'}`
              : 'Route ready — tap Start',
          tone: 'success',
        });
      })
      .finally(() => setPlanBusy(false));
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

  const handleProfileChange = (profile: RoutingProfileId) => {
    navigationService.setProfile(profile);
    const end =
      tripPlanner.getDestinationCoordinate() ?? nav.destination ?? null;
    if (
      end &&
      (nav.status === 'choosing' ||
        nav.status === 'error' ||
        nav.status === 'idle')
    ) {
      void navigationService.planRoute(
        resolveStart(),
        end,
        tripPlanner.getWaypoints(),
      );
    }
  };

  const handleGoToMyLocation = () => {
    if (!fix) {
      void locationService.startWatching();
      return;
    }
    setFollowGps(true);
    mapService.centerOn([fix.longitude, fix.latitude]);
  };

  const handleStop = () => {
    dismissRideMode();
    void setBrowserFullscreen(false);
    navigationService.stop();
  };

  const openSaveShareSheet = (mode: SaveShareMode) => {
    if (!navigationService.getActiveCalculatedRoute()) {
      setToast({ message: 'No route to save yet', tone: 'error' });
      return;
    }
    setSheetError(null);
    setSheetBusy(false);
    setSheetMode(mode);
  };

  const handleSheetConfirm = async (name: string) => {
    if (!sheetMode) return;
    setSheetBusy(true);
    setSheetError(null);
    try {
      if (sheetMode === 'save') {
        setToast({ message: 'Saving route…', tone: 'loading' });
        const saved = await navigationService.saveActiveRoute(name);
        setLibraryTick((n) => n + 1);
        setSheetMode(null);
        setScreen('library');
        setToast({ message: `Saved “${saved.name}”`, tone: 'success' });
      } else {
        setToast({ message: 'Preparing share file…', tone: 'loading' });
        const snapshot = navigationService.buildSavedSnapshot(name);
        if (!snapshot) throw new Error('No route to share');
        await routeLibrary.exportAndShare(snapshot, 'trailcompass');
        setSheetMode(null);
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
    }
  };

  const handleOpenSavedRoute = (route: SavedRoute) => {
    tripPlanner.loadFromSaved(route.end, route.waypoints ?? []);
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
    >
      {screen === 'map' ? (
        <main className="tc-main tc-main-map">
          <MapView
            fix={fix}
            followGps={followGps}
            navigating={navMode}
            onMapClick={handleMapClick}
            onFollowBreak={() => setFollowGps(false)}
            onRoutePick={(index) => {
              if (navMode) return;
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
            />
          </aside>

          {!mapPickActive ? (
            <div className="tc-map-dock">
              <RouteOptionsPanel
                visible={showRouteOptions}
                profile={nav.profile ?? 'fastest'}
                alternatives={nav.alternatives ?? []}
                selectedIndex={nav.selectedAlternativeIndex ?? 0}
                showAllRoutes={nav.showAllRoutes === true}
                onProfileChange={handleProfileChange}
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
                onPlan={handlePlanRoute}
                onStart={() => handleStartNavigation()}
                onStop={handleStop}
                onExitRide={dismissRideMode}
                onSaveRoute={() => openSaveShareSheet('save')}
                onShareRoute={() => openSaveShareSheet('share')}
              />
            </div>
          ) : null}

          <SaveShareRouteSheet
            open={sheetMode != null}
            mode={sheetMode ?? 'save'}
            route={navigationService.getActiveCalculatedRoute()}
            profile={nav.profile}
            busy={sheetBusy}
            error={sheetError}
            onClose={() => {
              if (!sheetBusy) {
                setSheetMode(null);
                setSheetError(null);
              }
            }}
            onConfirm={(name) => void handleSheetConfirm(name)}
          />

          {toast ? (
            <StatusToast message={toast.message} tone={toast.tone} />
          ) : null}
        </main>
      ) : screen === 'plan' ? (
        <div className="tc-plan-shell">
          <PlanScreen
            gpsCoordinate={gpsCoordinate}
            nav={nav}
            activeRoute={navigationService.getActiveCalculatedRoute()}
            engineReady={engine.ready}
            planning={planBusy || nav.status === 'planning'}
            onPreview={handlePreviewFromPlan}
            onStart={() => {
              handleStartNavigation();
              setScreen('map');
            }}
            onRequestMapPick={handleRequestMapPick}
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
          />
          {toast ? (
            <StatusToast message={toast.message} tone={toast.tone} />
          ) : null}
        </div>
      ) : (
        <OfflineScreen engine={engine} />
      )}

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
