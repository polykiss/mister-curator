import type { JSX } from 'react';
import { useState } from 'react';

import type { CoreEntry } from '@shared/types';

import { Button } from '@app/renderer/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';
import { Input } from '@app/renderer/src/components/ui/input';

interface Props {
  readonly core: CoreEntry | null;
  readonly ssDisplayName: string | null;
  readonly currentCustomName: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (name: string) => void;
}

export function CoreRenameDialog({
  core,
  ssDisplayName,
  currentCustomName,
  open,
  onOpenChange,
  onSave,
}: Props): JSX.Element {
  // Keyed by core.id in CoresPane so this state is always fresh on open.
  const [inputValue, setInputValue] = useState(currentCustomName ?? '');

  function handleSave(): void {
    onSave(inputValue);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename core</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          <div className="grid gap-1.5">
            <Input
              autoFocus
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={ssDisplayName ?? core?.id ?? ''}
            />
            <p className="text-body-sm text-fg-muted">
              Technical ID: {core?.id}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
