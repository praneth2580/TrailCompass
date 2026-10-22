import { useEffect, useState } from 'react';
import { MapView } from '../components/MapView';
import { NavigationBanner } from '../components/NavigationBanner';
import { RouteProgressOverlay } from '../components/RouteProgressOverlay';
import { RouteOptionsPanel } from '../components/RouteOptionsPanel';
import { SavedRoutesPanel } from '../components/SavedRoutesPanel';
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
  offlineRoutingAdapter,
  type OfflineEngineStatus,
} from '../routing/offline-adapter';
import type { Coordinate } from '../routing/routing-adapter';
import type { GpsFix, NavigationState } from '../types/navigation';
import type { SavedRoute } from '../types/route';
import {
  setBrowserFullscreen,
  useRideFullscreen,
} from '../hooks/useRideFullscreen';
import { APP_ROUTES, type AppScreen } from './routes';

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('map');
  const [fix, setFix] = useState<GpsFix | null>(null);
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

  const { rideMode, dismissRideMode } = useRideFullscreen({
    status: nav.status,
    fix,
  });

  const navMode =
    nav.status === 'navigating' || nav.status === 'rerouting';
  const immersive = navMode || rideMode;
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
    const unsubNav = navigationService.subscribe(setNav);
    const unsubEngine = offlineRoutingAdapter.subscribe(setEngine);

    void locationService.startWatching();
    void compassService.start();
    void navigationService.ensureEngine();

    const tick = window.setInterval(() => setNow(Date.now()), 2000);

    return () => {
      unsubLoc();
      unsubNav();
      unsubEngine();
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
    !navMode;

  const resolveStart = (): Coordinate => {
    if (fix) return [fix.longitude, fix.latitude];
    const center = mapService.getCenter();
    if (center) return center;
    if (nav.destination) {
      return [nav.destination[0] - 0.01, nav.destination[1] - 0.01];
    }
    return [0, 0];
  };

  const handleMapClick = (coordinate: Coordinate) => {
    if (rideMode) {
      dismissRideMode();
      return;
    }
    if (navMode) return;
    setFollowGps(false);
    mapService.setDestination(coordinate);
    navigationService.setDestination(coordinate);
  };

  const handlePlanRoute = () => {
    if (!nav.destination) return;
    void navigationService.planRoute(resolveStart(), nav.destination);
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
    if (
      nav.destination &&
      (nav.status === 'choosing' ||
        nav.status === 'error' ||
        nav.status === 'idle')
    ) {
      void navigationService.planRoute(resolveStart(), nav.destination);
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
    navigationService.loadSavedRoute(route);
    setFollowGps(true);
    setScreen('map');
    setToast({
      message: `Loaded “${route.name}” — tap Start`,
      tone: 'success',
    });
  };

  return (
    <div
      className="tc-app"
      data-screen={screen}
      data-nav={navMode ? 'true' : undefined}
      data-ride={rideMode ? 'true' : undefined}
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
          </aside>

          <RouteProgressOverlay
            active={nav.status === 'planning' || nav.status === 'rerouting'}
            progress={nav.progress}
          />

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
      ) : (
        <main className="tc-main tc-main-downloads">
          <header className="tc-downloads-hero">
            <p className="tc-downloads-brand">TrailCompass</p>
            <h1 className="tc-section-title">Library</h1>
            <p className="tc-section-copy">
              Saved routes travel as files. Offline map packages and Valhalla
              tiles stay separate.
            </p>
          </header>

          <SavedRoutesPanel
            refreshKey={libraryTick}
            onOpenRoute={handleOpenSavedRoute}
          />

          <section className="tc-storage" aria-label="Routing engine">
            <div className="tc-storage-row">
              <span className="tc-storage-label">Routing engine</span>
              <span className="tc-storage-value">
                {engine.ready ? engine.kind : 'none'}
              </span>
            </div>
            <p className="tc-section-copy">{engine.message}</p>
            {engine.attribution ? (
              <p className="tc-section-copy">{engine.attribution}</p>
            ) : null}
          </section>

          <h2 className="tc-list-heading">Regions</h2>
          <section className="tc-region-list" aria-label="Available regions">
            <article className="tc-region">
              <div className="tc-region-body">
                <h3 className="tc-region-name">
                  {engine.network?.label ?? 'Demo graph network'}
                </h3>
                <p className="tc-region-meta">
                  Bundled OSM ways for offline graph routing
                </p>
              </div>
              <span
                className={
                  engine.ready
                    ? 'tc-region-badge tc-region-badge-ok'
                    : 'tc-region-badge'
                }
              >
                {engine.ready ? 'Ready' : 'Unavailable'}
              </span>
            </article>
            <article className="tc-region">
              <div className="tc-region-body">
                <h3 className="tc-region-name">Valhalla tiles</h3>
                <p className="tc-region-meta">
                  Optional · place valhalla-tiles.tar in assets/routing
                </p>
              </div>
              <span className="tc-region-badge">
                {engine.kind === 'valhalla' ? 'Active' : 'Not loaded'}
              </span>
            </article>
          </section>
        </main>
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
            onClick={() => setScreen(route.id)}
            aria-current={screen === route.id ? 'page' : undefined}
          >
            <span className="tc-nav-icon" aria-hidden>
              {route.id === 'map' ? (
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
              ) : (
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
              )}
            </span>
            <span className="tc-nav-label">{route.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function formatSpeedKmh(mps: number): string {
  return `${Math.round(mps * 3.6)} km/h`;
}
