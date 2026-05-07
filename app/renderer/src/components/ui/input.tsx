import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';

import { cn } from '@app/renderer/src/lib/cn';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, ...props },
  ref,
) {
  return (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-8 w-full rounded border border-default bg-chrome px-3 text-body text-fg transition-colors',
        'placeholder:text-fg-disabled',
        'focus-visible:border-emphasis focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        'disabled:cursor-not-allowed disabled:bg-elevated disabled:text-fg-disabled',
        className,
      )}
      {...props}
    />
  );
});
