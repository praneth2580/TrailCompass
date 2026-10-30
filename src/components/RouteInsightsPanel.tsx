import { useEffect, useState } from 'react';
import type { RideRecord } from '../database/ride-repository';
import {
  formatDifference,
  formatDuration,
  formatHour,
  formatKm,
  PERIOD_LABELS,
  PERIODS,
  TRAFFIC_LABELS,
} from '../services/ride-format';
import { TRAFFIC_COLORS, trafficLevel, type RouteAnalysis, type SlowSpot } from '../services/ride-insights';
import { rideInsights, type RideRoute } from '../services/ride-insights.service';
import { ridePeriod, type RidePeriod } from '../services/ride-track';
import { TrackThumbnail } from './TrackThumbnail';

interface RouteInsightsPanelProps {
  route: RideRoute;
  /** Where Back goes: "Routes", or a place's name. */
  backLabel: string;
  onBack: () => void;
  onShowRide: (ride: RideRecord) => void;
  /** Opens the map; `draw` puts the traffic on it once it's showing. */
  onShowTraffic: (title: string, draw: () => void) => void;
}

type Loaded = { key: string; analysis: RouteAnalysis } | { key: string; error: string };

/** One route over all its rides: usual times, when to set off, where it's slow. */
export function RouteInsightsPanel({ route, backLabel, onBack, onShowRide, onShowTraffic }: RouteInsightsPanelProps) {
  const [period, setPeriod] = useState<RidePeriod | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = `${route.id}:${route.rides.length}:${period ?? 'all'}`;

  useEffect(() => {
    let alive = true;
    rideInsights
      .analyze(route, period)
      .then((analysis) => {
        if (alive) setLoaded({ key, analysis });
      })
      .catch((e: unknown) => {
        if (alive) setLoaded({ key, error: e instanceof Error ? e.message : 'Could not read these rides' });
      });
    return () => {
      alive = false;
    };
  }, [key, route, period]);

  const analysis = loaded && 'analysis' in loaded ? loaded.analysis : null;
  const stale = loaded?.key !== key;

  // Names for the slow spots' roads, looked up online if need be.
  useEffect(() => {
    for (const spot of analysis?.slowSpots ?? []) rideInsights.nameAt(spot.center, 'road');
  }, [analysis]);

  const periods = PERIODS.map((id) => ({
    id,
    rides: route.trips.filter((trip) => ridePeriod(new Date(trip.departedAt)) === id).length,
  })).filter((entry) => entry.rides > 0);
  const ridesById = new Map(route.rides.map((ride) => [ride.id, ride]));

  const showTraffic = (focus?: SlowSpot) => {
    if (!analysis) return;
    const title = period ? `${route.name} · ${PERIOD_LABELS[period].toLowerCase()}` : route.name;
    onShowTraffic(title, () => rideInsights.showTraffic(route, analysis, focus));
  };

  return (
    <div className="tc-insights">
      <button type="button" className="tc-insights-back" onClick={onBack}>
        <BackIcon />
        {backLabel}
      </button>

      <header className="tc-insights-head">
        <TrackThumbnail coordinates={route.path} />
        <div>
          <h2 className="tc-insights-title">{route.name}</h2>
          <p className="tc-insights-sub">
            {[route.via ? `via ${route.via}` : null, formatKm(route.lengthMeters), `${route.rides.length} ${route.rides.length === 1 ? 'ride' : 'rides'}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </header>

      {periods.length > 1 ? (
        <div className="tc-insights-periods" role="group" aria-label="Rides setting off">
          {[{ id: null, rides: route.rides.length }, ...periods].map((entry) => (
            <button
              key={entry.id ?? 'all'}
              type="button"
              className="tc-chip"
              aria-pressed={period === entry.id}
              onClick={() => setPeriod(entry.id)}
            >
              {entry.id ? PERIOD_LABELS[entry.id] : 'All'} <span>{entry.rides}</span>
            </button>
          ))}
        </div>
      ) : null}

      {loaded && 'error' in loaded && !stale ? (
        <div className="tc-library-notice" data-tone="err" role="alert">
          <span>{loaded.error}</span>
        </div>
      ) : !analysis ? (
        <div className="tc-saved-loading" role="status">
          <span className="tc-spinner" aria-hidden />
          <span>Comparing {route.rides.length} rides…</span>
        </div>
      ) : (
        <div className="tc-insights-body" data-stale={stale ? 'true' : undefined} aria-busy={stale}>
          <div className="tc-insights-stats">
            <Stat label="Usually" value={formatDuration(analysis.typicalSeconds)} />
            <Stat label="Best" value={formatDuration(analysis.bestSeconds)} />
            <Stat label="Slowest" value={formatDuration(analysis.slowestSeconds)} />
          </div>
          <p className="tc-insights-note">
            Setting off to arriving, pauses and stops of 5 minutes or more left out. Usual
            speed {Math.round((analysis.lengthMeters / Math.max(1, analysis.typicalSeconds)) * 3.6)} km/h.
          </p>

          <button type="button" className="tc-btn tc-btn-sm tc-insights-map" onClick={() => showTraffic()}>
            <MapIcon />
            Show traffic on the map
          </button>

          {analysis.byHour.length > 1 ? <HourBars byHour={analysis.byHour} /> : null}

          <section className="tc-insights-section" aria-labelledby="tc-slow-heading">
            <h3 className="tc-list-heading" id="tc-slow-heading">
              Where traffic slows you
            </h3>
            {analysis.slowSpots.length === 0 ? (
              <p className="tc-insights-note">
                No slow stretches: traffic usually keeps moving on this route.
              </p>
            ) : (
              <ol className="tc-slow-list">
                {analysis.slowSpots.map((spot) => (
                  <SlowSpotRow key={`${spot.from}`} spot={spot} onShow={() => showTraffic(spot)} />
                ))}
              </ol>
            )}
          </section>

          <section className="tc-insights-section" aria-labelledby="tc-route-rides-heading">
            <h3 className="tc-list-heading" id="tc-route-rides-heading">
              Rides
            </h3>
            <ul className="tc-insights-rides">
              {analysis.rides.map((timing) => {
                const ride = ridesById.get(timing.id);
                if (!ride) return null;
                const difference = formatDifference(timing.seconds, analysis.typicalSeconds);
                const set = new Date(timing.departedAt);
                return (
                  <li key={timing.id}>
                    <button type="button" onClick={() => onShowRide(ride)}>
                      <span className="tc-insights-ride-when">
                        <strong>{set.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</strong>
                        <span>set off {set.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                      </span>
                      <span className="tc-insights-ride-time">{formatDuration(timing.seconds)}</span>
                      <span
                        className="tc-insights-ride-diff"
                        data-sign={difference === 'usual' ? 'usual' : timing.seconds < analysis.typicalSeconds ? 'faster' : 'slower'}
                      >
                        {difference}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="tc-insights-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** The usual time by the hour the rides set off; the quickest hour picked out. */
function HourBars({ byHour }: { byHour: RouteAnalysis['byHour'] }) {
  const longest = Math.max(...byHour.map((entry) => entry.typicalSeconds));
  const quickest = byHour.reduce((best, entry) => (entry.typicalSeconds < best.typicalSeconds ? entry : best));
  const tied = byHour.filter((entry) => entry.typicalSeconds === quickest.typicalSeconds).length > 1;
  return (
    <section className="tc-insights-section" aria-labelledby="tc-hours-heading">
      <h3 className="tc-list-heading" id="tc-hours-heading">
        When you set off
      </h3>
      {!tied ? (
        <p className="tc-insights-note">
          Quickest setting off around {formatHour(quickest.hour)}: usually {formatDuration(quickest.typicalSeconds)}.
        </p>
      ) : null}
      <ul className="tc-hour-bars">
        {byHour.map((entry) => (
          <li key={entry.hour} data-quickest={!tied && entry === quickest ? 'true' : undefined}>
            <span className="tc-hour-label">{formatHour(entry.hour)}</span>
            <span className="tc-hour-track" aria-hidden>
              <span className="tc-hour-bar" style={{ width: `${Math.max(4, (entry.typicalSeconds / longest) * 100)}%` }} />
            </span>
            <span className="tc-hour-value">
              {formatDuration(entry.typicalSeconds)}
              <small>
                {' '}
                · {entry.rides} {entry.rides === 1 ? 'ride' : 'rides'}
              </small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SlowSpotRow({ spot, onShow }: { spot: SlowSpot; onShow: () => void }) {
  const level = trafficLevel(spot.speedKmh);
  const road = rideInsights.knownNameAt(spot.center, 'road');
  const where = `${(spot.from / 1000).toFixed(1)}–${(spot.to / 1000).toFixed(1)} km in`;
  return (
    <li className="tc-slow-spot">
      <span className="tc-slow-dot" style={{ background: TRAFFIC_COLORS[level] }} aria-hidden />
      <span className="tc-slow-text">
        <strong>{road ?? where}</strong>
        <span>
          {TRAFFIC_LABELS[level].name}, {Math.round(spot.speedKmh)} km/h · usually {formatDuration(spot.typicalSeconds)} for{' '}
          {Math.round((spot.to - spot.from) / 10) * 10} m, best {formatDuration(spot.bestSeconds)}
        </span>
        <span className="tc-slow-meta">
          About {formatDuration(spot.lostSeconds)} lost here{road ? ` · ${where}` : ''}
        </span>
      </span>
      <button type="button" className="tc-trip-icon" aria-label="Show this stretch on the map" title="Show on map" onClick={onShow}>
        <MapIcon />
      </button>
    </li>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MapIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path
        d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Zm0 0v14m6-12v14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
