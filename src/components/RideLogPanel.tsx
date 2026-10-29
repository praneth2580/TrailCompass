import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { rideRepository, type RideRecord } from '../database/ride-repository';
import { formatEtaShort } from '../routing/route-naming';
import { LOCATION_SOURCES } from '../services/location.service';
import { rideLogService } from '../services/ride-log.service';
import type { StoredTrack } from '../services/ride-track';
import { TrackThumbnail } from './TrackThumbnail';

interface RideLogPanelProps {
  /** Opens the map with the ride drawn on it. */
  onShowRide: (ride: RideRecord) => void;
  /** A ride was kept as a trip. */
  onTripSaved?: () => void;
}

interface Notice {
  text: string;
  tone: 'ok' | 'err';
  /** A deleted ride that Undo can put back. */
  undo?: { ride: RideRecord; track: StoredTrack | null };
}

/** Recorded rides, newest first. */
export function RideLogPanel({ onShowRide, onTripSaved }: RideLogPanelProps) {
  const [rides, setRides] = useState<RideRecord[] | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: 'gpx' | 'trip' | 'delete' } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const reload = useCallback(async () => setRides(await rideLogService.list()), []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void rideLogService.list().then((list) => {
        if (alive) setRides(list);
      });
    load();
    const off = rideLogService.subscribeSaved(load);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = async (ride: RideRecord, action: 'gpx' | 'trip' | 'delete', work: () => Promise<Notice | null>) => {
    setBusy({ id: ride.id, action });
    setNotice(null);
    try {
      const next = await work();
      if (next) setNotice(next);
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : 'Something went wrong', tone: 'err' });
    } finally {
      setBusy(null);
    }
  };

  const handleGpx = (ride: RideRecord) =>
    run(ride, 'gpx', async () => {
      const shared = await rideLogService.exportGpx(ride);
      if (!shared) return null;
      return {
        text: Capacitor.isNativePlatform() ? `Sharing “${ride.name}” as GPX` : `Downloaded “${ride.name}” as GPX`,
        tone: 'ok',
      };
    });

  const handleSaveTrip = (ride: RideRecord) =>
    run(ride, 'trip', async () => {
      const trip = await rideLogService.saveAsTrip(ride);
      onTripSaved?.();
      return { text: `Saved “${trip.name}” to your trips, to ride again`, tone: 'ok' };
    });

  const handleDelete = (ride: RideRecord) =>
    run(ride, 'delete', async () => {
      const track = await rideRepository.getTrack(ride.id);
      await rideLogService.delete(ride);
      await reload();
      return { text: `Deleted “${ride.name}”`, tone: 'ok', undo: { ride, track } };
    });

  const handleUndo = async ({ ride, track }: NonNullable<Notice['undo']>) => {
    setNotice(null);
    await rideRepository.save(ride, track ?? undefined);
    await reload();
  };

  const total = (rides ?? []).reduce((sum, ride) => sum + ride.distanceMeters, 0);
  const anyBusy = busy != null;

  return (
    <section className="tc-library" aria-labelledby="tc-rides-heading">
      <div className="tc-library-head">
        <h2 className="tc-list-heading" id="tc-rides-heading">
          Rides
          {rides && rides.length > 0 ? (
            <span className="tc-library-count">
              {' '}
              · {rides.length} · {formatKm(total)}
            </span>
          ) : null}
        </h2>
      </div>

      {notice ? (
        <div className="tc-library-notice" data-tone={notice.tone} role="status">
          <span>{notice.text}</span>
          {notice.undo ? (
            <button type="button" onClick={() => void handleUndo(notice.undo!)}>
              Undo
            </button>
          ) : null}
        </div>
      ) : null}

      {rides == null ? (
        <div className="tc-saved-loading" role="status">
          <span className="tc-spinner" aria-hidden />
          <span>Loading rides…</span>
        </div>
      ) : rides.length === 0 ? (
        <div className="tc-library-empty">
          <span className="tc-library-empty-icon" aria-hidden>
            <RecordIcon />
          </span>
          <strong>No rides yet</strong>
          <p>
            Tap the record button on the map to record a ride. It keeps
            recording with the screen off. With the setting on (Offline →
            Location), navigating records too.
          </p>
        </div>
      ) : (
        <ul className="tc-library-list">
          {rides.map((ride) => (
            <li key={ride.id} className="tc-trip">
              <button type="button" className="tc-trip-open" onClick={() => onShowRide(ride)} disabled={anyBusy}>
                <TrackThumbnail coordinates={ride.preview} />
                <span className="tc-trip-text">
                  <strong>{ride.routeName ? `${ride.name} · ${ride.routeName}` : ride.name}</strong>
                  <span className="tc-trip-facts">{rideFacts(ride)}</span>
                  <span className="tc-trip-meta">{rideMeta(ride)}</span>
                </span>
              </button>
              <div className="tc-trip-actions">
                <button
                  type="button"
                  className="tc-trip-icon"
                  aria-label={`Export ${ride.name} as GPX`}
                  title="Export GPX"
                  onClick={() => void handleGpx(ride)}
                  disabled={anyBusy}
                >
                  {busy?.id === ride.id && busy.action === 'gpx' ? <span className="tc-spinner tc-spinner-sm" aria-hidden /> : <ShareIcon />}
                </button>
                <button
                  type="button"
                  className="tc-trip-icon"
                  aria-label={`Save ${ride.name} as a trip`}
                  title="Save as trip"
                  onClick={() => void handleSaveTrip(ride)}
                  disabled={anyBusy}
                >
                  {busy?.id === ride.id && busy.action === 'trip' ? <span className="tc-spinner tc-spinner-sm" aria-hidden /> : <SaveTripIcon />}
                </button>
                <button
                  type="button"
                  className="tc-trip-icon tc-trip-icon-danger"
                  aria-label={`Delete ${ride.name}`}
                  onClick={() => void handleDelete(ride)}
                  disabled={anyBusy}
                >
                  {busy?.id === ride.id && busy.action === 'delete' ? <span className="tc-spinner tc-spinner-sm" aria-hidden /> : <TrashIcon />}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {rides && rides.length > 0 ? (
        <p className="tc-library-hint">
          Tap a ride to see it on the map. Export sends a GPX file for other
          apps; Save as trip keeps its path to ride again.
        </p>
      ) : null}
    </section>
  );
}

/** "42.1 km · 1h 12m · avg 35 km/h" */
function rideFacts(ride: RideRecord): string {
  const parts = [formatKm(ride.distanceMeters), formatEtaShort(ride.movingSeconds)];
  if (ride.movingSeconds > 0) parts.push(`avg ${Math.round((ride.distanceMeters / ride.movingSeconds) * 3.6)} km/h`);
  return parts.join(' · ');
}

/** "29 Oct, 07:12 · top 78 km/h · climb 320 m · Satellites only" */
function rideMeta(ride: RideRecord): string {
  const started = new Date(ride.startedAt);
  const parts = [
    started.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  ];
  if (ride.maxSpeedMps > 0) parts.push(`top ${Math.round(ride.maxSpeedMps * 3.6)} km/h`);
  if (ride.climbMeters > 0) parts.push(`climb ${ride.climbMeters} m`);
  parts.push(LOCATION_SOURCES.find((source) => source.id === ride.source)?.label ?? ride.source);
  return parts.join(' · ');
}

function formatKm(meters: number): string {
  const km = meters / 1000;
  return km >= 100 ? `${Math.round(km).toLocaleString()} km` : `${km.toFixed(1)} km`;
}

function RecordIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="4" fill="currentColor" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path
        d="M12 15V4m0 0L8 8m4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SaveTripIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path
        d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Zm6 4v6m-3-3h6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path
        d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
