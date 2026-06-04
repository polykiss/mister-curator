import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@app/renderer/src/lib/cn';

interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}

/**
 * Switch — a controlled on/off toggle (SYSTEM.md §5, D17). Zero-dependency
 * (a `<button role="switch">`), matching this repo's hand-rolled primitive
 * style (badge.tsx, table.tsx). Accent-green track when on; receded
 * `bg-overlay` track when off; near-white knob. Replaces the row of
 * `<input type="checkbox" className="accent-accent">` view-option controls.
 *
 * Drop-in for any boolean preference:
 *   <Switch checked={showHidden} onCheckedChange={setShowHidden} />
 *
 * Keep the `<label>` wrapper around it for the text + the click target;
 * the label's `htmlFor`/wrapping still toggles via the button's onClick.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  function Switch(
    { checked, onCheckedChange, className, disabled, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          // D35: exact dimensions from spec — 30×18px track
          'relative inline-flex h-[18px] w-[30px] shrink-0 cursor-pointer items-center rounded-full',
          'border border-transparent transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-accent' : 'bg-switch-off',
          className,
        )}
        {...props}
      >
        <span
          aria-hidden
          className={cn(
            // D35: 14×14px knob; 2px inset when off → translate(14px) when on
            'pointer-events-none block size-3.5 rounded-full shadow-sm transition-transform duration-200',
            checked ? 'bg-accent-fg' : 'bg-white',
            checked ? 'translate-x-[14px]' : 'translate-x-0.5',
          )}
        />
      </button>
    );
  },
);
