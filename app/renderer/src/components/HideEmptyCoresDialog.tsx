import { useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import type { CoreEntry } from '@shared/types';

import { Button } from '@app/renderer/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';
import { useCores } from '@app/renderer/src/contexts/CoresContext';
import { summarizeBulkResult } from '@app/renderer/src/lib/format';

interface HideEmptyCoresDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly candidates: readonly CoreEntry[];
}

export function HideEmptyCoresDialog({
  open,
  onOpenChange,
  candidates,
}: HideEmptyCoresDialogProps): JSX.Element {
  const { setBulkCoreVisibility } = useCores();
  const [submitting, setSubmitting] = useState(false);

  const onConfirm = async (): Promise<void> => {
    if (candidates.length === 0) return;
    setSubmitting(true);
    const changes = candidates.map((c) => ({ coreId: c.id, hidden: true }));
    try {
      const result = await setBulkCoreVisibility(changes);
      const summary = summarizeBulkResult({
        action: 'Hid',
        itemNoun: 'core',
        succeeded: result.succeeded,
        failed: result.failed,
        failedNames: result.failed.map((f) => f.coreId),
      });
      const surface =
        summary.kind === 'success'
          ? toast.success
          : summary.kind === 'partial'
            ? toast.warning
            : toast.error;
      surface(summary.title, {
        description: summary.description,
        action:
          summary.kind === 'success' && result.succeeded.length > 0
            ? {
                label: 'Undo',
                onClick: () => {
                  void (async () => {
                    try {
                      await setBulkCoreVisibility(
                        result.succeeded.map((id) => ({ coreId: id, hidden: false })),
                      );
                    } catch (err) {
                      toast.error('Could not undo', {
                        description:
                          err instanceof Error ? err.message : 'Unexpected error.',
                      });
                    }
                  })();
                },
              }
            : undefined,
        duration: 10000,
      });
      onOpenChange(false);
    } catch (err) {
      toast.error('Bulk hide failed', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Hide empty cores</DialogTitle>
          <DialogDescription>
            These cores have zero ROMs and will be removed from the MiSTer main menu
            until you restore them. Both their <code>games/</code> directory and their
            core file will be renamed.
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No empty cores to hide.</p>
        ) : (
          <div className="max-h-72 overflow-auto rounded-md border">
            <ul className="divide-y text-sm">
              {candidates.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {c.category}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Arcade cores excluded — coming in a later release.
        </p>

        <DialogFooter>
          <Button
            type="button"
            variant="subtle"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void onConfirm()}
            disabled={submitting || candidates.length === 0}
          >
            Hide all {String(candidates.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
