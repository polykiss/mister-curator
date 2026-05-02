import { useCallback, useEffect, useRef, useState } from 'react';

interface ResizablePaneOptions {
  /** Storage key used to persist the chosen width across launches. */
  readonly storageKey: string;
  /** Width in px on the very first run, before any drag. */
  readonly defaultWidth: number;
  /** Minimum width of the left pane. */
  readonly minLeft: number;
  /** Minimum width of the right pane. */
  readonly minRight: number;
}

interface ResizablePaneApi {
  readonly width: number;
  /** Attach to the divider's `onPointerDown`. */
  readonly onDragStart: (event: React.PointerEvent<HTMLElement>) => void;
  /** True while the user is mid-drag — useful for cursor + selection styling. */
  readonly isDragging: boolean;
}

/**
 * Persistent draggable-pane sizing for a horizontal split. Stores the
 * chosen width in localStorage under `storageKey` and clamps to the
 * supplied min widths against the current window inner width.
 *
 * Implemented by hand — the alternative was pulling in
 * `react-resizable-panels` (~20 kB) for a single split, which doesn't
 * pay back the dependency. The pointer-event handlers live on `document`
 * during drag so the cursor doesn't escape the pane.
 */
export function useResizablePaneWidth(options: ResizablePaneOptions): ResizablePaneApi {
  const { storageKey, defaultWidth, minLeft, minRight } = options;

  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const stored = window.localStorage.getItem(storageKey);
    const parsed = stored !== null ? Number.parseInt(stored, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultWidth;
  });
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  // Persist whenever the width settles. Cheap (one localStorage write
  // per drag end), and avoids spamming during drag.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isDragging) return;
    window.localStorage.setItem(storageKey, String(widthRef.current));
  }, [isDragging, storageKey]);

  const onDragStart = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      setIsDragging(true);

      const onMove = (e: PointerEvent): void => {
        const max = window.innerWidth - minRight;
        const next = Math.min(Math.max(e.clientX, minLeft), max);
        setWidth(next);
      };
      const onUp = (): void => {
        setIsDragging(false);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    },
    [minLeft, minRight],
  );

  return { width, onDragStart, isDragging };
}
