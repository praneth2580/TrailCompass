import type { SavedRoute } from '../types/route';
import { SavedRoutesPanel } from './SavedRoutesPanel';

interface LibraryScreenProps {
  refreshKey: number;
  onOpenRoute: (route: SavedRoute) => void;
  onPlanTrip: () => void;
}

export function LibraryScreen({
  refreshKey,
  onOpenRoute,
  onPlanTrip,
}: LibraryScreenProps) {
  return (
    <main className="tc-main tc-main-library">
      <header className="tc-library-hero">
        <p className="tc-downloads-brand">TrailCompass</p>
        <h1 className="tc-section-title">Library</h1>
        <p className="tc-section-copy">
          Trips you've saved, ready to ride again without planning.
        </p>
      </header>

      <SavedRoutesPanel
        refreshKey={refreshKey}
        onOpenRoute={onOpenRoute}
        onPlanTrip={onPlanTrip}
      />
    </main>
  );
}
