import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';

import { cn } from '@app/renderer/src/lib/cn';

// Outline pills per SYSTEM.md §5. The "no fills" rule on badges is
// load-bearing: HIDDEN and SYSTEM are metadata flags, not status
// alerts. A filled pill in the middle of a row reads as a button.
const badgeVariants = cva(
  'inline-flex h-[18px] shrink-0 items-center rounded-sm border px-1.5 text-caption font-medium uppercase tracking-[0.08em] not-italic',
  {
    variants: {
      variant: {
        // HIDDEN — receded; signals the row is downplayed.
        muted: 'border-default text-fg-muted',
        // SYSTEM — neutral identification, not alarming.
        info: 'border-info/60 text-info',
        // Future-use: warning, destructive — kept for symmetry.
        warning: 'border-warning/60 text-warning',
        destructive: 'border-destructive/60 text-destructive',
      },
    },
    defaultVariants: { variant: 'muted' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
});
