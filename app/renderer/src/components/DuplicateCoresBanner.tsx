import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import type { JSX } from 'react';

import { Button } from '@app/renderer/src/components/ui/button';
import { DuplicateResolveDialog } from '@app/renderer/src/components/DuplicateResolveDialog';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';

/**
 * feat/duplicate-detect-and-restore (#40) — non-blocking banner shown
 * when the connect sequence detects that both a dotted (hidden) and an
 * undotted (visible) form of the same core file coexist on the device.
 *
 * This typically happens after MiSTer's `update_all.sh` reinstalls a core
 * that the user had previously hidden via MiSTerCurator. The visible copy
 * causes MiSTer to display the core in its menu, defeating the hide.
 *
 * Dismiss is per-connect-session only (not persisted). If the issue is not
 * resolved the banner reappears on the next connect.
 */
export function DuplicateCoresBanner(): JSX.Element | null {
  const { detectedDuplicates, dismissDuplicates } = useConnection();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (detectedDuplicates === null || detectedDuplicates.length === 0) return null;

  const count = detectedDuplicates.length;
  const coreWord = count === 1 ? 'core has' : 'cores have';

  return (
    <>
      <div
        role="alert"
        className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-subtle border-l-2 border-l-warning bg-surface px-4 py-3"
      >
        <div className="flex min-w-0 items-center gap-2 text-body text-fg">
          <AlertTriangle
            className="size-4 shrink-0 text-warning"
            strokeWidth={1.5}
            aria-hidden
          />
          <span className="truncate font-medium">
            {String(count)} {coreWord} paired duplicate files — a MiSTer update reinstalled
            hidden cores. Your hidden state is preserved but MiSTer may show these cores in
            its menu until resolved.
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => { setDialogOpen(true); }}
          >
            Review &amp; Restore
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={dismissDuplicates}
          >
            Dismiss
          </Button>
        </div>
      </div>

      <DuplicateResolveDialog
        open={dialogOpen}
        pairs={detectedDuplicates}
        onClose={() => { setDialogOpen(false); }}
        onResolved={() => {
          setDialogOpen(false);
          dismissDuplicates();
        }}
      />
    </>
  );
}
