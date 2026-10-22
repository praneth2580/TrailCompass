import type { OfflineEngineStatus } from '../routing/offline-adapter';

interface OfflineScreenProps {
  engine: OfflineEngineStatus;
}

export function OfflineScreen({ engine }: OfflineScreenProps) {
  return (
    <main className="tc-main tc-main-downloads">
      <header className="tc-downloads-hero">
        <p className="tc-downloads-brand">TrailCompass</p>
        <h1 className="tc-section-title">Offline</h1>
        <p className="tc-section-copy">
          Routing engine status and map packages. Saved trips are on the Library
          tab.
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
  );
}
