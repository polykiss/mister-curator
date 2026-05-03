import type { HTMLAttributes, JSX } from 'react';

import { cn } from '@app/renderer/src/lib/cn';

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn('animate-pulse rounded bg-elevated', className)}
      {...props}
    />
  );
}
