import { useEffect, useState } from 'react';
import { MapView } from '../components/MapView';
import { CompassWidget } from '../components/CompassWidget';
import { NavigationBanner } from '../components/NavigationBanner';
import { DownloadProgress } from '../components/DownloadProgress';
import { locationService, formatAccuracy, isFixStale } from '../services/location.service';
import { compassService } from '../services/compass.service';
import { navigationService } from '../services/navigation.service';
import type { CompassReading, GpsFix, NavigationState } from '../types/navigation';
import { APP_ROUTES, type AppScreen } from './routes';

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('map');
  const [fix, setFix] = useState<GpsFix | null>(null);
  const [locationError, setLocationError] = useState<string | undefined>();
  const [compass, setCompass] = useState<CompassReading | null>(null);
  const [nav, setNav] = useState<NavigationState>(navigationService.getState());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const unsubLoc = locationService.subscribe((next, error) => {
      setFix(next);
      setLocationError(error);
    });
    const unsubCompass = compassService.subscribe(setCompass);
    const unsubNav = navigationService.subscribe(setNav);

    void locationService.startWatching();
    void compassService.start();

    const tick = window.setInterval(() => setNow(Date.now()), 2000);

    return () => {
      unsubLoc();
      unsubCompass();
      unsubNav();
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

  const handlePlanRoute = () => {
    const start: [number, number] = fix
      ? [fix.longitude, fix.latitude]
      : [0, 0];
    // Destination is arbitrary — adapter will reject until offline engine exists.
    void navigationService.planRoute(start, [start[0] + 0.05, start[1] + 0.05]);
  };

  return (
    <div className="tc-app">
      <header className="tc-header">
        <h1 className="tc-brand">TrailCompass</h1>
        <nav className="tc-nav" aria-label="Main">
          {APP_ROUTES.map((route) => (
            <button
              key={route.id}
              type="button"
              className={
                screen === route.id ? 'tc-tab tc-tab-active' : 'tc-tab'
              }
              onClick={() => setScreen(route.id)}
            >
              {route.label}
            </button>
          ))}
        </nav>
      </header>

      {screen === 'map' ? (
        <main className="tc-main">
          <MapView fix={fix} />

          <aside className="tc-hud">
            <div className="tc-gps-panel">
              <span className="tc-gps-label">GPS</span>
              {fix ? (
                <>
                  <span className="tc-gps-coords">
                    {fix.latitude.toFixed(5)}, {fix.longitude.toFixed(5)}
                  </span>
                  <span className={stale ? 'tc-gps-stale' : 'tc-gps-ok'}>
                    {formatAccuracy(fix)}
                    {stale ? ' · STALE' : ''}
                  </span>
                </>
              ) : (
                <span className="tc-gps-missing">
                  {locationError ?? 'Waiting for GPS fix…'}
                </span>
              )}
            </div>

            <CompassWidget
              reading={compass}
              onEnable={() => void compassService.start()}
            />
          </aside>

          <NavigationBanner
            state={nav}
            onPlanDemo={handlePlanRoute}
            onStop={() => navigationService.stop()}
          />
        </main>
      ) : (
        <main className="tc-main tc-main-downloads">
          <h2 className="tc-section-title">Offline regions</h2>
          <p className="tc-section-copy">
            Regional package downloads will appear here. Bulk downloading from
            public OSM tile servers is not supported.
          </p>
          <DownloadProgress
            regionName="Demo region (not available)"
            percent={0}
            statusMessage="Download pipeline pending — provide a lawful package source first."
            visible
          />
        </main>
      )}
    </div>
  );
}
