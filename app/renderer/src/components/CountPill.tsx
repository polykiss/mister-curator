import type { JSX } from 'react';

import { cn } from '@app/renderer/src/lib/cn';

type CountTone = 'neutral' | 'hidden' | 'system';

// Status dot per tone. `neutral` (total ROMs) shows no dot; `hidden` is
// amber, `system` is blue — matching the comps and the sidebar count dots.
const DOT_CLASS: Record<Exclude<CountTone, 'neutral'>, string> = {
  hidden: 'bg-warning',
  system: 'bg-info',
};

/**
 * CountPill — a single count chip in the pane-header count summary
 * (SYSTEM.md §5, D16). Filled elevated surface (`bg-overlay rounded-md`),
 * NOT an outline — live counts warrant a solid visual weight. The number
 * is bold in `fg`, the label receded in `fg-muted`, with an optional
 * leading status dot.
 *
 *   <CountPill count={680} label="ROMs" />
 *   <CountPill count={42}  label="hidden" tone="hidden" />
 *   <CountPill count={6}   label="system" tone="system" />
 */
export function CountPill({
  count,
  label,
  tone = 'neutral',
  className,
}: {
  readonly count: number | string;
  readonly label: string;
  readonly tone?: CountTone;
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-overlay px-1.5',
        'text-caption text-fg-muted tabular',
        className,
      )}
    >
      {tone !== 'neutral' ? (
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[tone])}
        />
      ) : null}
      <span className="font-bold text-fg">{count}</span>
      {label}
    </span>
  );
}
