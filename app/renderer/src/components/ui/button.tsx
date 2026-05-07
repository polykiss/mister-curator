import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@app/renderer/src/lib/cn';

// Six variants per SYSTEM.md §5. Only `primary` carries a solid fill —
// at most one primary button should be visible per screen at any time
// (PR #8 round 4: stacked solid buttons read as shouting). Default
// rest-action variant is `secondary` (outlined).
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-active',
        secondary:
          'border border-emphasis bg-transparent text-fg hover:bg-elevated hover:text-fg',
        destructive:
          'border border-destructive bg-transparent text-destructive hover:bg-destructive/10',
        ghost: 'bg-transparent text-fg-body hover:bg-elevated hover:text-fg',
        link: 'bg-transparent text-accent underline-offset-4 hover:underline',
        subtle: 'bg-elevated text-fg hover:bg-overlay',
      },
      size: {
        sm: 'h-7 px-3 text-body-sm [&_svg]:size-3.5',
        default: 'h-8 px-3 text-body [&_svg]:size-4',
        lg: 'h-9 px-4 text-body [&_svg]:size-4',
        icon: 'h-8 w-8 [&_svg]:size-4',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  readonly asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
});

export { buttonVariants };
