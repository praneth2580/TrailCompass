import { useEffect, useState } from 'react';
import { MapView } from '../components/MapView';
import { CompassWidget } from '../components/CompassWidget';
import { NavigationBanner } from '../components/NavigationBanner';
import { RouteProgressOverlay } from '../components/RouteProgressOverlay';
import { RouteOptionsPanel } from '../components/RouteOptionsPanel';
import type { RoutingProfileId } from '../routing/routing-profiles';
import {
  locationService,
  formatGpsChipLabel,
  isFixStale,
} from '../services/location.service';
import { compassService } from '../services/compass.service';
import { navigationService } from '../services/navigation.service';
import { mapService } from '../services/map.service';
import {
  offlineRoutingAdapter,
  type OfflineEngineStatus,
} from '../routing/offline-adapter';
import type { Coordinate } from '../routing/routing-adapter';
import type { CompassReading, GpsFix, NavigationState } from '../types/navigation';
import { APP_ROUTES, type AppScreen } from './routes';

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('map');
  const [fix, setFix] = useState<GpsFix | null>(null);
  const [locationError, setLocationError] = useState<string | undefined>();
  const [compass, setCompass] = useState<CompassReading | null>(null);
  const [nav, setNav] = useState<NavigationState>(navigationService.getState());
  const [engine, setEngine] = useState<OfflineEngineStatus>(
    offlineRoutingAdapter.getStatus(),
  );
  const [now, setNow] = useState(() => Date.now());
  const [followGps, setFollowGps] = useState(true);

  useEffect(() => {
    const unsubLoc = locationService.subscribe((next, error) => {
      setFix(next);
      setLocationError(error);
    });
    const unsubCompass = compassService.subscribe(setCompass);
    const unsubNav = navigationService.subscribe(setNav);
    const unsubEngine = offlineRoutingAdapter.subscribe(setEngine);

    void locationService.startWatching();
    void compassService.start();
    void navigationService.ensureEngine();

    const tick = window.setInterval(() => setNow(Date.now()), 2000);

    return () => {
      unsubLoc();
      unsubCompass();
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

  const stale = fix ? isFixStale(fix, now) : false;
  const gpsTone = !fix || locationError ? 'missing' : stale ? 'stale' : 'ok';
  const canPlan = Boolean(nav.destination) && engine.ready;

  const resolveStart = (): Coordinate => {
    // Always route from the real GPS fix (or current map center) — never
    // substitute a distant demo point, which produced nonsense routes.
    if (fix) return [fix.longitude, fix.latitude];
    const center = mapService.getCenter();
    if (center) return center;
    if (nav.destination) {
      // Offset slightly so start ≠ destination when GPS is missing.
      return [nav.destination[0] - 0.01, nav.destination[1] - 0.01];
    }
    return [0, 0];
  };

  const handleMapClick = (coordinate: Coordinate) => {
    setFollowGps(false);
    mapService.setDestination(coordinate);
    navigationService.setDestination(coordinate);
  };

  const handlePlanRoute = () => {
    if (!nav.destination) return;
    void navigationService.planRoute(resolveStart(), nav.destination);
  };

  const handleProfileChange = (profile: RoutingProfileId) => {
    navigationService.setProfile(profile);
    // Re-plan when already navigating so the new preference applies.
    if (
      nav.destination &&
      (nav.status === 'navigating' ||
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

  return (
    <div className="tc-app" data-screen={screen}>
      {screen === 'map' ? (
        <main className="tc-main tc-main-map">
          <MapView
            fix={fix}
            followGps={followGps}
            onMapClick={handleMapClick}
            onRoutePick={(index) => navigationService.selectAlternative(index)}
          />

          <button
            type="button"
            className="tc-locate-btn"
            onClick={handleGoToMyLocation}
            disabled={!fix}
            aria-label="Go to my location"
            title={fix ? 'Go to my location' : 'Waiting for GPS…'}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
              <path
                d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="2" />
              <circle cx="12" cy="12" r="2.75" fill="currentColor" />
            </svg>
          </button>

          <aside className="tc-hud" aria-label="Ride instruments">
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
            </div>

            <div
              className="tc-engine-chip"
              title={engine.attribution}
              role="status"
            >
              <span className="tc-engine-chip-label">Route</span>
              <span className="tc-engine-chip-value">
                {engine.ready ? engine.label : 'Offline pending'}
              </span>
            </div>

            <CompassWidget
              reading={compass}
              onEnable={() => void compassService.start()}
            />
          </aside>

          <RouteProgressOverlay
            active={nav.status === 'planning' || nav.status === 'rerouting'}
            progress={nav.progress}
          />

          <div className="tc-map-dock">
            <RouteOptionsPanel
              visible={
                Boolean(nav.destination) &&
                nav.status !== 'planning' &&
                nav.status !== 'rerouting'
              }
              profile={nav.profile ?? 'fastest'}
              alternatives={nav.alternatives ?? []}
              selectedIndex={nav.selectedAlternativeIndex ?? 0}
              showAllRoutes={nav.showAllRoutes === true}
              onProfileChange={handleProfileChange}
              onSelectAlternative={(index) =>
                navigationService.selectAlternative(index)
              }
              onToggleShowAll={(showAll) =>
                navigationService.setShowAllRoutes(showAll)
              }
            />

            <NavigationBanner
              state={nav}
              canPlan={canPlan}
              onPlan={handlePlanRoute}
              onStop={() => navigationService.stop()}
            />
          </div>
        </main>
      ) : (
        <main className="tc-main tc-main-downloads">
          <header className="tc-downloads-hero">
            <p className="tc-downloads-brand">TrailCompass</p>
            <h1 className="tc-section-title">Offline regions</h1>
            <p className="tc-section-copy">
              Map packages and Valhalla routing tiles are separate. Install
              lawful regional data before you ride — no bulk OSM tile scraping.
            </p>
          </header>

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
                  engine.ready ? 'tc-region-badge tc-region-badge-ok' : 'tc-region-badge'
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
              screen === route.id ? 'tc-nav-item tc-nav-item-active' : 'tc-nav-item'
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
