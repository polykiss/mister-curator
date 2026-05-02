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
      await setBulkCoreVisibility(changes);
      const noun = candidates.length === 1 ? 'empty core' : 'empty cores';
      toast.success(`Hid ${String(candidates.length)} ${noun}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await setBulkCoreVisibility(
                  changes.map((c) => ({ ...c, hidden: false })),
                );
                toast.success(`Restored ${String(candidates.length)} ${noun}`);
              } catch (err) {
                toast.error('Could not undo', {
                  description: err instanceof Error ? err.message : 'Unexpected error.',
                });
              }
            })();
          },
        },
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
            variant="ghost"
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
