import { formatSavedAt } from '../routing/route-naming';
import { formatDuration, formatKm } from '../services/ride-format';
import type { RideGroups, RidePlace, RideRoute } from '../services/ride-insights.service';
import { TrackThumbnail } from './TrackThumbnail';

/** Routes ridden more than once, most ridden first. */
export function RideRoutesList({ groups, onOpen }: { groups: RideGroups; onOpen: (route: RideRoute) => void }) {
  const routes = groups.routes.filter((route) => route.rides.length >= 2);
  const grouped = routes.reduce((sum, route) => sum + route.rides.length, 0);

  if (routes.length === 0) {
    return (
      <div className="tc-library-empty">
        <span className="tc-library-empty-icon" aria-hidden>
          <RepeatIcon />
        </span>
        <strong>No routes yet</strong>
        <p>
          Ride the same way twice (to work and back, say) and it shows up
          here: how long it usually takes, when it&rsquo;s quickest to set off,
          and where traffic slows you.
        </p>
      </div>
    );
  }

  return (
    <>
      <ul className="tc-library-list">
        {routes.map((route) => (
          <li key={route.id} className="tc-trip">
            <button type="button" className="tc-trip-open" onClick={() => onOpen(route)}>
              <TrackThumbnail coordinates={route.path} />
              <span className="tc-trip-text">
                <strong>{route.name}</strong>
                <span className="tc-trip-facts">
                  {route.rides.length} rides · usually {formatDuration(route.typicalSeconds)} · best{' '}
                  {formatDuration(route.bestSeconds)}
                </span>
                <span className="tc-trip-meta">
                  {[
                    route.via ? `via ${route.via}` : null,
                    formatKm(route.lengthMeters),
                    `last ridden ${formatSavedAt(new Date(route.lastRiddenAt).toISOString())}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <ChevronIcon />
            </button>
          </li>
        ))}
      </ul>
      <p className="tc-library-hint">
        {groups.rideCount > grouped
          ? `${groups.rideCount - grouped} of your ${groups.rideCount} rides ${groups.rideCount - grouped === 1 ? "doesn't" : "don't"} share a route with another yet. `
          : ''}
        Rides count as one route when they take the same roads the same way.
      </p>
    </>
  );
}

/** Places ridden to more than once, most visited first. */
export function RidePlacesList({ groups, onOpen }: { groups: RideGroups; onOpen: (place: RidePlace) => void }) {
  const places = groups.places
    .filter((place) => place.arrivals >= 2 || (place.named && place.arrivals + place.departures > 0))
    .sort((a, b) => b.arrivals - a.arrivals || b.departures - a.departures);

  if (places.length === 0) {
    return (
      <div className="tc-library-empty">
        <span className="tc-library-empty-icon" aria-hidden>
          <PinIcon />
        </span>
        <strong>No places yet</strong>
        <p>
          Places you ride to more than once show up here, to compare the
          different ways you&rsquo;ve taken to get there.
        </p>
      </div>
    );
  }

  return (
    <>
      <ul className="tc-library-list">
        {places.map((place) => {
          const ways = groups.routes.filter((route) => route.endPlaceId === place.id).length;
          return (
            <li key={place.id} className="tc-trip">
              <button type="button" className="tc-trip-open" onClick={() => onOpen(place)}>
                <span className="tc-place-badge" aria-hidden>
                  <PinIcon />
                </span>
                <span className="tc-trip-text">
                  <strong>{place.name}</strong>
                  <span className="tc-trip-facts">
                    {place.arrivals} {place.arrivals === 1 ? 'ride' : 'rides'} here
                    {ways > 0 ? ` · ${ways} ${ways === 1 ? 'way' : 'ways'}` : ''}
                  </span>
                  {place.departures > 0 ? (
                    <span className="tc-trip-meta">
                      {place.departures} {place.departures === 1 ? 'ride' : 'rides'} from here
                    </span>
                  ) : null}
                </span>
                <ChevronIcon />
              </button>
            </li>
          );
        })}
      </ul>
      <p className="tc-library-hint">
        Rides ending within about 400 m of each other end at the same place.
        Open one to name it or compare the ways there.
      </p>
    </>
  );
}

export function ChevronIcon() {
  return (
    <svg className="tc-trip-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden>
      <path
        d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10" r="2.4" fill="currentColor" />
    </svg>
  );
}

function RepeatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden>
      <path
        d="M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4v1M7 21l-3-3 3-3M4 18h12a4 4 0 0 0 4-4v-1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
