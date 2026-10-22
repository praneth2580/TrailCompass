import type { RoutingProgress } from '../routing/routing-progress';

interface RouteProgressOverlayProps {
  progress?: RoutingProgress;
  active: boolean;
}

/**
 * Map overlay while planning/rerouting.
 * Shows a percent only when `progress.percent` is a real measured value
 * (e.g. Content-Length download). Otherwise spinner + label only.
 */
export function RouteProgressOverlay({
  progress,
  active,
}: RouteProgressOverlayProps) {
  if (!active || !progress || progress.phase === 'idle') return null;

  const showPercent =
    progress.percent != null &&
    Number.isFinite(progress.percent) &&
    progress.bytesTotal != null &&
    progress.bytesTotal > 0;

  return (
    <div className="tc-route-progress" role="status" aria-live="polite">
      <div className="tc-route-progress-spinner" aria-hidden />
      <div className="tc-route-progress-copy">
        <strong className="tc-route-progress-label">
          {progress.label || 'Working…'}
        </strong>
        {showPercent ? (
          <>
            <div className="tc-route-progress-track">
              <div
                className="tc-route-progress-fill"
                style={{ width: `${Math.round(progress.percent!)}%` }}
              />
            </div>
            <span className="tc-route-progress-pct">
              {Math.round(progress.percent!)}%
              {progress.bytesReceived != null && progress.bytesTotal != null
                ? ` · ${formatBytes(progress.bytesReceived)} / ${formatBytes(progress.bytesTotal)}`
                : ''}
            </span>
          </>
        ) : (
          <span className="tc-route-progress-hint">Please wait</span>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
