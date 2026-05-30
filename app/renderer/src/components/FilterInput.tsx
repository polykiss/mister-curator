import type { JSX, RefObject } from 'react';
import { Search, X } from 'lucide-react';

import { cn } from '@app/renderer/src/lib/cn';
import { Input } from '@app/renderer/src/components/ui/input';

interface FilterInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * feat/filter-as-you-type (#21) — shared filter input used by both
 * RomsPane and ArcadeMraPane headers. Renders a search icon on the
 * left, a clear (X) button on the right when the value is non-empty,
 * and handles Esc to clear + blur.
 */
export function FilterInput({
  value,
  onChange,
  placeholder,
  inputRef,
}: FilterInputProps): JSX.Element {
  return (
    <div className="relative flex items-center">
      <Search
        className="pointer-events-none absolute left-2.5 size-3.5 text-fg-muted"
        strokeWidth={2}
        aria-hidden
      />
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn('h-8 pl-8', value !== '' ? 'pr-8' : 'pr-3')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onChange('');
            e.currentTarget.blur();
            e.preventDefault();
          }
        }}
      />
      {value !== '' ? (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
          className="absolute right-2 rounded p-0.5 text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X className="size-3.5" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}
