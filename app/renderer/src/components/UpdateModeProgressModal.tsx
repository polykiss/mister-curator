import { Loader2 } from 'lucide-react';
import type { JSX } from 'react';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';

export interface UpdateModeProgressModalProps {
  readonly open: boolean;
  readonly phase: 'entering' | 'restoring';
  readonly current: number;
  readonly total: number;
}

export function titleFor(phase: 'entering' | 'restoring'): string {
  return phase === 'entering' ? 'Preparing library for update…' : 'Restoring curation…';
}

export function helperTextFor(phase: 'entering' | 'restoring'): string {
  return phase === 'entering'
    ? 'Un-hiding files so your update tool can see them'
    : 'Re-hiding your previously curated files';
}

export function progressPercent(current: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((current / total) * 100);
}

export function UpdateModeProgressModal({
  open,
  phase,
  current,
  total,
}: UpdateModeProgressModalProps): JSX.Element {
  const percent = progressPercent(current, total);

  return (
    <Dialog open={open}>
      <DialogContent
        hideDefaultClose
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        className="max-w-sm"
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <Loader2
              className="size-5 shrink-0 animate-spin text-accent"
              strokeWidth={1.5}
              aria-hidden
            />
            <DialogTitle>{titleFor(phase)}</DialogTitle>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-overlay">
            <div
              className="h-full bg-accent transition-[width] duration-300"
              style={{ width: `${String(percent)}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-body-sm text-fg-muted">
            <span>{helperTextFor(phase)}</span>
            {total > 0 && (
              <span className="shrink-0 font-mono">
                {String(current)} / {String(total)}
              </span>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
