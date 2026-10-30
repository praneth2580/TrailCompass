import { useState } from 'react';
import type { RideRecord } from '../database/ride-repository';
import type { SavedRoute } from '../types/route';
import { RideLogPanel, type RideLibraryView } from './RideLogPanel';
import { SavedRoutesPanel } from './SavedRoutesPanel';

export type LibraryTab = 'trips' | 'rides';

interface LibraryScreenProps {
  refreshKey: number;
  onOpenRoute: (route: SavedRoute) => void;
  onPlanTrip: () => void;
  onShowRide: (ride: RideRecord) => void;
  onShowTraffic: (title: string, draw: () => void) => void;
  tab: LibraryTab;
  onTabChange: (tab: LibraryTab) => void;
  rideView: RideLibraryView;
  onRideViewChange: (view: RideLibraryView) => void;
}

const TABS: Array<{ id: LibraryTab; label: string }> = [
  { id: 'trips', label: 'Trips' },
  { id: 'rides', label: 'Rides' },
];

export function LibraryScreen({
  refreshKey,
  onOpenRoute,
  onPlanTrip,
  onShowRide,
  onShowTraffic,
  tab,
  onTabChange,
  rideView,
  onRideViewChange,
}: LibraryScreenProps) {
  // A ride saved as a trip shows up when switching back to Trips.
  const [tripsKey, setTripsKey] = useState(0);

  return (
    <main className="tc-main tc-main-library">
      <header className="tc-library-hero">
        <p className="tc-downloads-brand">TrailCompass</p>
        <h1 className="tc-section-title">Library</h1>
        <p className="tc-section-copy">
          {tab === 'trips'
            ? "Trips you've saved, ready to ride again without planning."
            : "Rides you've recorded, the routes you repeat, and where traffic slows you."}
        </p>
      </header>

      <div className="tc-route-type tc-library-tabs" role="tablist" aria-label="Library">
        {TABS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={tab === option.id}
            className={tab === option.id ? 'tc-route-type-option tc-route-type-option-active' : 'tc-route-type-option'}
            onClick={() => onTabChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {tab === 'trips' ? (
        <SavedRoutesPanel refreshKey={refreshKey + tripsKey} onOpenRoute={onOpenRoute} onPlanTrip={onPlanTrip} />
      ) : (
        <RideLogPanel
          view={rideView}
          onViewChange={onRideViewChange}
          onShowRide={onShowRide}
          onShowTraffic={onShowTraffic}
          onTripSaved={() => setTripsKey((n) => n + 1)}
        />
      )}
    </main>
  );
}
