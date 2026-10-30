import { useState } from 'react';
import { formatDuration, formatKm, PERIOD_LABELS } from '../services/ride-format';
import { compareByPeriod } from '../services/ride-insights';
import { rideInsights, type RideGroups, type RidePlace, type RideRoute } from '../services/ride-insights.service';
import { ChevronIcon, PinIcon } from './RideGroupLists';
import { TrackThumbnail } from './TrackThumbnail';

interface PlaceInsightsPanelProps {
  place: RidePlace;
  groups: RideGroups;
  backLabel: string;
  onBack: () => void;
  onOpenRoute: (route: RideRoute) => void;
}

/** A way counts as quicker from a minute's difference: less is the traffic lights. */
const QUICKEST_MARGIN_SECONDS = 60;

/** A place: the ways you've ridden there (and from there), side by side. */
export function PlaceInsightsPanel({ place, groups, backLabel, onBack, onOpenRoute }: PlaceInsightsPanelProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const placeName = (id: string) => groups.places.find((other) => other.id === id)?.name ?? 'Elsewhere';

  const here = groupBy(
    groups.routes.filter((route) => route.endPlaceId === place.id),
    (route) => route.startPlaceId,
  ).map(([from, routes]) => ({ key: `from-${from}`, title: from === place.id ? 'Round trips' : `From ${placeName(from)}`, routes }));
  const away = groupBy(
    groups.routes.filter((route) => route.startPlaceId === place.id && route.endPlaceId !== place.id),
    (route) => route.endPlaceId,
  ).map(([to, routes]) => ({ key: `to-${to}`, title: `To ${placeName(to)}`, routes }));

  const save = async () => {
    if (draft == null) return;
    setSaving(true);
    try {
      await rideInsights.renamePlace(place, draft);
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tc-insights">
      <button type="button" className="tc-insights-back" onClick={onBack}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
          <path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {backLabel}
      </button>

      <header className="tc-insights-head">
        <span className="tc-place-badge" aria-hidden>
          <PinIcon />
        </span>
        {draft == null ? (
          <div>
            <h2 className="tc-insights-title">{place.name}</h2>
            <p className="tc-insights-sub">
              {place.arrivals} {place.arrivals === 1 ? 'ride' : 'rides'} here · {place.departures} from here
            </p>
            <button type="button" className="tc-btn-ghost" onClick={() => setDraft(place.named ? place.name : '')}>
              {place.named ? 'Rename' : 'Name this place'}
            </button>
          </div>
        ) : (
          <form
            className="tc-place-rename"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="tc-sheet-field">
              <span className="tc-sheet-label">Name, like Home or Office</span>
              <input
                className="tc-sheet-input"
                type="text"
                value={draft}
                maxLength={40}
                placeholder={place.name}
                disabled={saving}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setDraft(null);
                }}
              />
            </label>
            <div className="tc-place-rename-actions">
              <button type="submit" className="tc-btn tc-btn-sm" disabled={saving}>
                Save
              </button>
              <button type="button" className="tc-btn tc-btn-sm tc-btn-secondary" disabled={saving} onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
            {place.named ? <p className="tc-insights-note">Leave it empty to go back to the map&rsquo;s name.</p> : null}
          </form>
        )}
      </header>

      {[
        { id: 'here', heading: 'Ways here', sections: here },
        { id: 'away', heading: 'Ways from here', sections: away },
      ].map(({ id, heading, sections }) =>
        sections.length === 0 ? null : (
          <section key={id} className="tc-insights-section" aria-labelledby={`tc-place-${id}`}>
            <h3 className="tc-list-heading" id={`tc-place-${id}`}>
              {heading}
            </h3>
            {sections.map((section) => (
              <WaysList key={section.key} title={section.title} routes={section.routes} onOpen={onOpenRoute} />
            ))}
          </section>
        ),
      )}
      <p className="tc-library-hint">
        Each way is its own route: rides on the same roads, the same way. With
        one ride, its time is just that ride&rsquo;s.
      </p>
    </div>
  );
}

/** Ways between the same two places, quickest first, then compared at the same time of day. */
function WaysList({ title, routes, onOpen }: { title: string; routes: RideRoute[]; onOpen: (route: RideRoute) => void }) {
  const sorted = [...routes].sort((a, b) => a.typicalSeconds - b.typicalSeconds);
  const quickest =
    sorted.length > 1 && sorted[1]!.typicalSeconds - sorted[0]!.typicalSeconds >= QUICKEST_MARGIN_SECONDS ? sorted[0] : null;
  const sameTime = compareByPeriod(sorted.map((route) => ({ way: route, trips: route.trips })));
  return (
    <div className="tc-ways">
      <h4 className="tc-ways-title">{title}</h4>
      <ul className="tc-library-list">
        {sorted.map((route) => (
          <li key={route.id} className="tc-trip">
            <button type="button" className="tc-trip-open" onClick={() => onOpen(route)}>
              <TrackThumbnail coordinates={route.path} />
              <span className="tc-trip-text">
                <strong>
                  {wayName(route)}
                  {route === quickest ? <span className="tc-badge">Quickest</span> : null}
                </strong>
                <span className="tc-trip-facts">
                  usually {formatDuration(route.typicalSeconds)} · {route.rides.length}{' '}
                  {route.rides.length === 1 ? 'ride' : 'rides'}
                </span>
                <span className="tc-trip-meta">
                  {formatKm(route.lengthMeters)}
                  {route.rides.length > 1 ? ` · best ${formatDuration(route.bestSeconds)}` : ''}
                </span>
              </span>
              <ChevronIcon />
            </button>
          </li>
        ))}
      </ul>
      {sameTime.length > 0 ? (
        <dl className="tc-ways-periods" aria-label="At the same time of day">
          {sameTime.map(({ period, ways }) => (
            <div key={period}>
              <dt>{PERIOD_LABELS[period]}s</dt>
              {ways.map(({ way, typicalSeconds, rides }) => (
                <dd key={way.id}>
                  <span>{wayName(way)}</span>
                  <span>
                    {formatDuration(typicalSeconds)}
                    <small>
                      {' '}
                      · {rides} {rides === 1 ? 'ride' : 'rides'}
                    </small>
                  </span>
                </dd>
              ))}
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function wayName(route: RideRoute): string {
  return route.via ? `Via ${route.via}` : `${formatKm(route.lengthMeters)} way`;
}

/** Routes by `keyOf`, most ridden group first. */
function groupBy(routes: RideRoute[], keyOf: (route: RideRoute) => string): Array<[string, RideRoute[]]> {
  const groups = new Map<string, RideRoute[]>();
  for (const route of routes) groups.set(keyOf(route), [...(groups.get(keyOf(route)) ?? []), route]);
  const rides = (members: RideRoute[]) => members.reduce((sum, route) => sum + route.rides.length, 0);
  return [...groups].sort((a, b) => rides(b[1]) - rides(a[1]));
}
