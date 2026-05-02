import type { JSX } from 'react';

import { useCores } from '@app/renderer/src/contexts/CoresContext';
import { Skeleton } from '@app/renderer/src/components/ui/skeleton';
import { cn } from '@app/renderer/src/lib/cn';

export function CoresPane(): JSX.Element {
  const { cores, coresLoading, coresError, selectedCoreId, selectCore } = useCores();

  if (coresLoading && cores === null) {
    return (
      <div className="space-y-1 p-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (coresError !== null) {
    return (
      <div className="p-4 text-sm text-destructive">{coresError}</div>
    );
  }

  if (!cores || cores.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">No cores found.</div>
    );
  }

  return (
    <ul className="divide-y" role="listbox" aria-label="MiSTer cores">
      {cores.map((core) => {
        const isSelected = core.id === selectedCoreId;
        return (
          <li key={core.id}>
            <button
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => selectCore(core.id)}
              className={cn(
                'flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent',
                isSelected && 'bg-accent',
              )}
            >
              <span className="truncate font-medium">{core.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {core.romCount}
                {core.hiddenCount > 0 ? (
                  <span className="ml-1 italic">({core.hiddenCount} hidden)</span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
