import { useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';
import { Button } from '@app/renderer/src/components/ui/button';
import type { DuplicateAction, DuplicatePair } from '@shared/types';

interface Props {
  readonly open: boolean;
  readonly pairs: readonly DuplicatePair[];
  readonly onClose: () => void;
  readonly onResolved: () => void;
}

/**
 * feat/duplicate-detect-and-restore (#40) — modal dialog that presents
 * each detected duplicate pair as a table row and lets the user choose
 * an action per pair:
 *
 *   Keep hidden  — delete the undotted (visible) path, preserve hidden state
 *   Keep visible — delete the dotted (hidden) path, effectively unhide on device
 *   Skip         — leave both copies on device (banner reappears on next connect)
 *
 * Defaults every row to "Keep hidden" — the common intent after update_all.
 */
export function DuplicateResolveDialog({
  open,
  pairs,
  onClose,
  onResolved,
}: Props): JSX.Element {
  const [actions, setActions] = useState<Record<string, DuplicateAction>>(() => {
    const init: Record<string, DuplicateAction> = {};
    for (const p of pairs) {
      // Use visiblePath as the key — unique per pair.
      init[p.visiblePath] = 'keep-hidden';
    }
    return init;
  });
  const [applying, setApplying] = useState(false);

  const setAction = (visiblePath: string, action: DuplicateAction): void => {
    setActions((prev) => ({ ...prev, [visiblePath]: action }));
  };

  const keepHiddenCount = Object.values(actions).filter((a) => a === 'keep-hidden').length;
  const keepVisibleCount = Object.values(actions).filter((a) => a === 'keep-visible').length;
  const skipCount = Object.values(actions).filter((a) => a === 'skip').length;
  const activeCount = keepHiddenCount + keepVisibleCount;

  const onApply = async (): Promise<void> => {
    setApplying(true);
    try {
      const resolutions = pairs.map((p) => ({
        visiblePath: p.visiblePath,
        hiddenPath: p.hiddenPath,
        action: actions[p.visiblePath] ?? 'skip',
      }));
      const result = await window.mister.resolveDuplicateCores(resolutions);
      if (result.failed > 0) {
        toast.warning(`Resolved ${String(result.deleted)} duplicate${result.deleted !== 1 ? 's' : ''}`, {
          description: `${String(result.failed)} deletion${result.failed !== 1 ? 's' : ''} failed — check SSH connectivity and try again.`,
        });
      } else {
        toast.success(`Resolved ${String(result.deleted)} duplicate${result.deleted !== 1 ? 's' : ''}`);
      }
      onResolved();
    } catch (err) {
      toast.error('Could not resolve duplicates', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    } finally {
      setApplying(false);
    }
  };

  const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Resolve duplicate core files</DialogTitle>
        </DialogHeader>

        <p className="text-body-sm text-fg-muted">
          Each row has both a hidden (dotted) and a visible (undotted) copy on the device.
          Choose how to resolve each pair — the other copy will be deleted.
        </p>

        <div className="max-h-72 overflow-y-auto rounded border border-default">
          <table className="w-full text-body-sm">
            <thead className="sticky top-0 bg-overlay">
              <tr className="border-b border-default text-left text-fg-muted">
                <th className="px-3 py-2 font-medium">Core</th>
                <th className="px-3 py-2 font-medium">Visible file (undotted)</th>
                <th className="px-3 py-2 font-medium">Hidden file (dotted)</th>
                <th className="px-3 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((p) => (
                <tr key={p.visiblePath} className="border-b border-subtle last:border-0">
                  <td className="px-3 py-2 font-medium text-fg">{p.coreName}</td>
                  <td className="px-3 py-2 font-mono text-fg-muted">{basename(p.visiblePath)}</td>
                  <td className="px-3 py-2 font-mono text-fg-muted">{basename(p.hiddenPath)}</td>
                  <td className="px-3 py-2">
                    <select
                      value={actions[p.visiblePath] ?? 'keep-hidden'}
                      onChange={(e) => { setAction(p.visiblePath, e.target.value as DuplicateAction); }}
                      className="rounded border border-default bg-surface px-2 py-1 text-body-sm text-fg focus:outline-none focus:ring-1 focus:ring-accent"
                      disabled={applying}
                    >
                      <option value="keep-hidden">Keep hidden</option>
                      <option value="keep-visible">Keep visible</option>
                      <option value="skip">Skip</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-body-sm text-fg-muted">
          {keepHiddenCount > 0 && (
            <span>{String(keepHiddenCount)} will be restored to hidden state. </span>
          )}
          {keepVisibleCount > 0 && (
            <span>{String(keepVisibleCount)} will be unhidden on device. </span>
          )}
          {skipCount > 0 && (
            <span>{String(skipCount)} skipped.</span>
          )}
        </p>

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { void onApply(); }}
            disabled={applying || activeCount === 0}
          >
            {applying ? 'Applying…' : `Apply ${String(activeCount)} change${activeCount !== 1 ? 's' : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
