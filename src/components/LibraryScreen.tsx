import type { SavedRoute } from '../types/route';
import { SavedRoutesPanel } from './SavedRoutesPanel';

interface LibraryScreenProps {
  refreshKey: number;
  onOpenRoute: (route: SavedRoute) => void;
}

export function LibraryScreen({
  refreshKey,
  onOpenRoute,
}: LibraryScreenProps) {
  return (
    <main className="tc-main tc-main-library">
      <header className="tc-library-hero">
        <p className="tc-downloads-brand">TrailCompass</p>
        <h1 className="tc-section-title">Library</h1>
        <p className="tc-section-copy">
          Your saved trips live here. Open one to preview on the map, or import
          a <code>.trailcompass.json</code> file from another device.
        </p>
      </header>

      <SavedRoutesPanel refreshKey={refreshKey} onOpenRoute={onOpenRoute} />
    </main>
  );
}
