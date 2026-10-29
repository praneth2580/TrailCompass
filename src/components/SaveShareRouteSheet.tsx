import { useEffect, useId, useRef, useState } from 'react';
import type { CalculatedRoute } from '../routing/routing-adapter';
import {
  formatDistanceShort,
  formatEtaShort,
  suggestRouteName,
} from '../routing/route-naming';
import type { RoutingProfileId } from '../routing/routing-profiles';
import { useBackHandler } from '../hooks/useBackHandler';

export type SaveShareMode = 'save' | 'share';

interface SaveShareRouteSheetProps {
  open: boolean;
  mode: SaveShareMode;
  route: CalculatedRoute | null;
  profile?: RoutingProfileId;
  busy: boolean;
  /** Replaces the busy button's label, e.g. "Map 40%". */
  progress?: string | null;
  error?: string | null;
  onClose: () => void;
  onConfirm: (name: string, withMap: boolean) => void;
  /** Stops the map download; keeps Cancel usable while it runs. */
  onCancelBusy?: () => void;
}

export function SaveShareRouteSheet({
  open,
  mode,
  route,
  profile,
  busy,
  progress,
  error,
  onClose,
  onConfirm,
  onCancelBusy,
}: SaveShareRouteSheetProps) {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState('');
  const [seed, setSeed] = useState('');
  const [withMap, setWithMap] = useState(true);
  const openKey =
    open && route
      ? `${mode}:${route.id ?? ''}:${route.distanceMeters}:${route.durationSeconds}`
      : '';

  if (openKey && openKey !== seed) {
    setSeed(openKey);
    setName(suggestRouteName(route!, profile));
    setWithMap(true);
  } else if (!openKey && seed) {
    setSeed('');
  }

  useEffect(() => {
    if (!open || !route) return;
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 40);
    return () => window.clearTimeout(id);
  }, [open, openKey, route]);

  useBackHandler(open && route != null, onClose);

  if (!open || !route) return null;

  const title = mode === 'save' ? 'Save route' : 'Share route file';
  const confirmLabel = mode === 'save' ? 'Save to library' : 'Share file';
  const hint =
    mode === 'save'
      ? 'Stored on this device. Open it anytime from Library.'
      : withMap
        ? 'Sends the route with its map, so it opens offline on the other phone.'
        : 'Exports a .trailcompass.json file you can send to another device.';
  const mapHint =
    mode === 'save'
      ? 'Saves the map along the route, so it shows without signal.'
      : 'Adds the map along the route. A bigger file, up to about 50 MB.';

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  return (
    <div className="tc-sheet-root" role="presentation">
      <button
        type="button"
        className="tc-sheet-backdrop"
        aria-label="Close"
        disabled={busy}
        onClick={onClose}
      />
      <div
        className="tc-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="tc-sheet-handle" aria-hidden />
        <header className="tc-sheet-header">
          <h2 id={titleId} className="tc-sheet-title">
            {title}
          </h2>
          <p className="tc-sheet-hint">{hint}</p>
        </header>

        <div className="tc-sheet-stats" aria-label="Route summary">
          <span>{formatDistanceShort(route.distanceMeters)}</span>
          <span aria-hidden>·</span>
          <span>{formatEtaShort(route.durationSeconds)}</span>
          {route.label ? (
            <>
              <span aria-hidden>·</span>
              <span>{route.label}</span>
            </>
          ) : null}
        </div>

        <label className="tc-sheet-field">
          <span className="tc-sheet-label">Route name</span>
          <input
            ref={inputRef}
            className="tc-sheet-input"
            type="text"
            value={name}
            maxLength={80}
            disabled={busy}
            placeholder="Name this ride"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) onConfirm(trimmed, withMap);
              if (e.key === 'Escape' && !busy) onClose();
            }}
          />
        </label>

        <label className="tc-sheet-check">
          <input
            type="checkbox"
            checked={withMap}
            disabled={busy}
            onChange={(e) => setWithMap(e.target.checked)}
          />
          <span>
            <strong>Offline map</strong>
            <span>{mapHint}</span>
          </span>
        </label>

        {error ? (
          <p className="tc-sheet-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="tc-sheet-actions">
          <button
            type="button"
            className="tc-btn tc-btn-secondary"
            onClick={busy ? onCancelBusy : onClose}
            disabled={busy && !onCancelBusy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="tc-btn"
            onClick={() => onConfirm(trimmed, withMap)}
            disabled={!canSubmit}
          >
            {busy ? (
              <>
                <span className="tc-spinner tc-spinner-sm" aria-hidden />
                {progress ?? (mode === 'save' ? 'Saving…' : 'Preparing…')}
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
