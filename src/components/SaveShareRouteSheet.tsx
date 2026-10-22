import { useEffect, useId, useRef, useState } from 'react';
import type { CalculatedRoute } from '../routing/routing-adapter';
import {
  formatDistanceShort,
  formatEtaShort,
  suggestRouteName,
} from '../routing/route-naming';
import type { RoutingProfileId } from '../routing/routing-profiles';

export type SaveShareMode = 'save' | 'share';

interface SaveShareRouteSheetProps {
  open: boolean;
  mode: SaveShareMode;
  route: CalculatedRoute | null;
  profile?: RoutingProfileId;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (name: string) => void;
}

export function SaveShareRouteSheet({
  open,
  mode,
  route,
  profile,
  busy,
  error,
  onClose,
  onConfirm,
}: SaveShareRouteSheetProps) {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState('');
  const [seed, setSeed] = useState('');
  const openKey =
    open && route
      ? `${mode}:${route.id ?? ''}:${route.distanceMeters}:${route.durationSeconds}`
      : '';

  if (openKey && openKey !== seed) {
    setSeed(openKey);
    setName(suggestRouteName(route!, profile));
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

  if (!open || !route) return null;

  const title = mode === 'save' ? 'Save route' : 'Share route file';
  const confirmLabel = mode === 'save' ? 'Save to library' : 'Share file';
  const hint =
    mode === 'save'
      ? 'Stored on this device. Open it anytime from Library.'
      : 'Exports a .trailcompass.json file you can send to another device.';

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
              if (e.key === 'Enter' && canSubmit) onConfirm(trimmed);
              if (e.key === 'Escape' && !busy) onClose();
            }}
          />
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
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="tc-btn"
            onClick={() => onConfirm(trimmed)}
            disabled={!canSubmit}
          >
            {busy ? (
              <>
                <span className="tc-spinner tc-spinner-sm" aria-hidden />
                {mode === 'save' ? 'Saving…' : 'Preparing…'}
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
