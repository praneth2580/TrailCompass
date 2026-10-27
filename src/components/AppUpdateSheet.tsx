import { useEffect, useId, useState } from 'react';
import {
  installAppUpdate,
  snoozeAppUpdate,
  subscribeAppUpdates,
  type AppUpdateStatus,
} from '../services/app-update.service';
import { useBackHandler } from '../hooks/useBackHandler';

/** Offers a newer TrailCompass release and walks through installing it. */
export function AppUpdateSheet() {
  const titleId = useId();
  const [status, setStatus] = useState<AppUpdateStatus>({ state: 'idle' });
  /** The state the rider closed the sheet in; a new state shows it again. */
  const [hiddenIn, setHiddenIn] = useState<AppUpdateStatus['state'] | null>(null);

  useEffect(() => subscribeAppUpdates(setStatus), []);

  const open =
    status.state !== hiddenIn &&
    ((status.state === 'available' && status.prompt) ||
      status.state === 'downloading' ||
      status.state === 'installing' ||
      status.state === 'needs-permission' ||
      (status.state === 'error' && status.release != null));

  const close = () => {
    if (status.state === 'available' || status.state === 'error') {
      snoozeAppUpdate();
      setHiddenIn(null);
    } else {
      // Downloading carries on; the installer still opens when it's done.
      setHiddenIn(status.state);
    }
  };

  useBackHandler(open, close);

  if (!open || !('release' in status) || !status.release) return null;
  const release = status.release;

  let title = 'Update available';
  let hint = `Version ${release.version} · ${megabytes(release.sizeBytes)} · you have ${status.current ?? 'an older version'}`;
  let body: React.ReactNode = null;
  let closeLabel = 'Later';
  let action: { label: string; run: () => void } | null = {
    label: 'Update',
    run: () => void installAppUpdate(),
  };

  if (status.state === 'available' && release.notes.length > 0) {
    body = (
      <ul className="tc-update-notes" aria-label="What's new">
        {release.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    );
  } else if (status.state === 'downloading') {
    const percent = status.total > 0 ? Math.round((status.bytes / status.total) * 100) : 0;
    title = 'Downloading update';
    hint = `${megabytes(status.bytes)} of ${megabytes(status.total)}`;
    body = (
      <div
        className="tc-route-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="tc-route-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    );
    closeLabel = 'Hide';
    action = null;
  } else if (status.state === 'installing') {
    title = 'Finish in the installer';
    hint = `Tap Install when Android asks. TrailCompass reopens on version ${release.version}.`;
    closeLabel = 'Close';
    action = { label: 'Open installer', run: () => void installAppUpdate() };
  } else if (status.state === 'needs-permission') {
    title = 'Allow updates';
    hint = 'Turn on "Allow from this source" for TrailCompass, then come back. The update continues by itself.';
    closeLabel = 'Not now';
    action = { label: 'Open settings', run: () => void installAppUpdate() };
  } else if (status.state === 'error') {
    title = "Update didn't finish";
    hint = status.message;
    closeLabel = 'Close';
    action = { label: 'Try again', run: () => void installAppUpdate() };
    body = (
      <a className="tc-update-link" href={release.pageUrl} target="_blank" rel="noreferrer">
        Download in the browser instead
      </a>
    );
  }

  return (
    <div className="tc-sheet-root" role="presentation">
      <button type="button" className="tc-sheet-backdrop" aria-label="Close" onClick={close} />
      <div className="tc-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="tc-sheet-handle" aria-hidden />
        <header className="tc-sheet-header">
          <h2 id={titleId} className="tc-sheet-title">
            {title}
          </h2>
          <p className="tc-sheet-hint">{hint}</p>
        </header>
        {body}
        <div className={action ? 'tc-sheet-actions' : 'tc-sheet-actions tc-sheet-actions-single'}>
          <button type="button" className="tc-btn tc-btn-secondary" onClick={close}>
            {closeLabel}
          </button>
          {action ? (
            <button type="button" className="tc-btn" onClick={action.run}>
              {action.label}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
