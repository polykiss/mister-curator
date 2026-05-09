import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

/**
 * Lightweight floating menu rendered next to a ROM row. Used for the
 * mark / unmark action — and any future per-row actions that don't fit
 * in the row itself.
 *
 * No dependency on a popup primitive (we don't ship one yet); positions
 * itself at `(x, y)` and dismisses on outside click or Escape. The
 * caller controls visibility.
 */
export interface RomRowMenuItem {
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly destructive?: boolean;
}

export interface RomRowMenuProps {
  readonly x: number;
  readonly y: number;
  readonly items: readonly RomRowMenuItem[];
  readonly onClose: () => void;
}

/** Distance kept from the viewport edges when flipping/clamping. */
export const VIEWPORT_PADDING = 8;

/**
 * Pure positioning math for the floating menu — extracted from the
 * component so the flip logic is testable without jsdom. Given the
 * anchor coords, the menu's measured size, and the viewport size,
 * returns the final `left` / `top` after right-edge clamp and
 * bottom-edge flip.
 *
 * Bottom-edge flip: when the menu's bottom would clip below the
 * viewport, open upward from the anchor instead — top = y - height.
 * Right-edge clamp: when the menu's right would overflow, shift left
 * just enough to keep the right edge inside the viewport. Both rules
 * fall back to `VIEWPORT_PADDING` when even the flip won't fit (menu
 * taller/wider than viewport).
 */
export function computeMenuPosition(args: {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly menuWidth: number;
  readonly menuHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}): { readonly left: number; readonly top: number } {
  const { anchorX, anchorY, menuWidth, menuHeight, viewportWidth, viewportHeight } =
    args;
  let left = anchorX;
  let top = anchorY;
  if (left + menuWidth > viewportWidth - VIEWPORT_PADDING) {
    left = Math.max(VIEWPORT_PADDING, viewportWidth - menuWidth - VIEWPORT_PADDING);
  }
  if (top + menuHeight > viewportHeight - VIEWPORT_PADDING) {
    top = Math.max(VIEWPORT_PADDING, anchorY - menuHeight);
  }
  return { left, top };
}

export function RomRowMenu(props: RomRowMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  // PR-D2 r2 c4: measure-then-flip collision detection. Round 1 used a
  // naive clamp with a hardcoded 80px height, which was correct when
  // the menu had two items but undersized after PR-D2 added two more
  // (Edit metadata + Find on ScreenScraper) — the fifth item rendered
  // off the bottom of the viewport on rows near the bottom of the
  // table. Now we measure the actual rendered box and either shift up
  // (right-edge clamp) or flip upward (bottom-edge clamp) when needed.
  //
  // First render uses the raw anchor coords with `visibility: hidden`
  // so the unmeasured position never paints. useLayoutEffect runs
  // synchronously before paint, measures the box, computes the final
  // position, and flips `measured`. The user sees only the corrected
  // position.
  const [position, setPosition] = useState<{
    readonly left: number;
    readonly top: number;
    readonly measured: boolean;
  }>({ left: props.x, top: props.y, measured: false });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const { left, top } = computeMenuPosition({
      anchorX: props.x,
      anchorY: props.y,
      menuWidth: rect.width,
      menuHeight: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setPosition({ left, top, measured: true });
  }, [props.x, props.y, props.items.length]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent): void {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      props.onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') props.onClose();
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [props]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[16rem] overflow-hidden rounded border border-default bg-overlay py-1 text-body text-fg shadow-popover"
      style={{
        left: position.left,
        top: position.top,
        // Hide the unmeasured first frame to avoid a flash at the
        // pre-flip position. useLayoutEffect runs before paint, so
        // the user only ever sees the corrected position.
        visibility: position.measured ? 'visible' : 'hidden',
      }}
    >
      {props.items.map((item, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            props.onClose();
          }}
          title={item.title}
          className={
            'flex w-full items-center px-3 py-2 text-left transition-colors ' +
            (item.disabled
              ? 'cursor-not-allowed text-fg-disabled'
              : item.destructive
                ? 'text-destructive hover:bg-destructive/10'
                : 'text-fg-body hover:bg-elevated hover:text-fg')
          }
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
