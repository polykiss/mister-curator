import { useEffect, useRef } from 'react';
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

export function RomRowMenu(props: RomRowMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

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

  // Clamp to the viewport so the menu doesn't get clipped off the right
  // / bottom edge. Naive math — assumes the menu is roughly 240×100,
  // which is fine for two items.
  const left = Math.min(props.x, window.innerWidth - 256);
  const top = Math.min(props.y, window.innerHeight - 80);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[16rem] overflow-hidden rounded border border-default bg-overlay py-1 text-body text-fg shadow-popover"
      style={{ left, top }}
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
