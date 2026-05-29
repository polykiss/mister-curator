import { useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

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

interface UpdateModeDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function UpdateModeDialog({ open, onOpenChange }: UpdateModeDialogProps): JSX.Element {
  const { enterUpdateMode } = useCores();
  const [submitting, setSubmitting] = useState(false);

  const onConfirm = async (): Promise<void> => {
    setSubmitting(true);
    const operationId = `update-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await enterUpdateMode(operationId);
      onOpenChange(false);
    } catch (err) {
      toast.error('Could not enter update mode', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={submitting ? undefined : onOpenChange}>
      <DialogContent hideDefaultClose={submitting}>
        <DialogHeader>
          <DialogTitle>Enter update mode</DialogTitle>
          <DialogDescription>
            All hidden files will be temporarily revealed so your MiSTer update tool can
            overwrite them without creating duplicates. A snapshot is saved to the device
            first — click <strong>Restore curation</strong> in the banner after your update
            completes to re-hide everything.
          </DialogDescription>
        </DialogHeader>
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
            variant="primary"
            onClick={() => void onConfirm()}
            disabled={submitting}
          >
            {submitting ? 'Revealing files…' : 'Enter update mode'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
