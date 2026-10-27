import { useEffect, useRef } from 'react';

type BackHandler = () => void;

/** Open overlays, oldest first. The newest one gets the back press. */
const handlers: BackHandler[] = [];

/**
 * Give the Android back button to the newest open overlay.
 * Returns false when no overlay is open.
 */
export function handleOverlayBack(): boolean {
  const handler = handlers[handlers.length - 1];
  if (!handler) return false;
  handler();
  return true;
}

/** While `active`, the Android back button calls `onBack` (e.g. close a sheet). */
export function useBackHandler(active: boolean, onBack: BackHandler): void {
  const onBackRef = useRef(onBack);

  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    if (!active) return;
    const handler = () => onBackRef.current();
    handlers.push(handler);
    return () => {
      const index = handlers.lastIndexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    };
  }, [active]);
}
