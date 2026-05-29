import { CheckCircle2 } from 'lucide-react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { Button } from '@app/renderer/src/components/ui/button';
import { useCores } from '@app/renderer/src/contexts/CoresContext';

export function UpdateModeBanner(): JSX.Element | null {
  const { updateModeActive, updateModeSnapshot, restoreFromUpdateMode } = useCores();

  if (!updateModeActive) return null;

  const totalFiles = updateModeSnapshot?.totalFiles ?? 0;
  const fileLabel = totalFiles === 1 ? '1 file' : `${String(totalFiles)} files`;

  const onRestore = async (): Promise<void> => {
    const operationId = `restore-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await restoreFromUpdateMode(operationId);
      const problematic = result.skippedMissing + result.failed;
      if (problematic > 0) {
        toast.warning(`Restored ${String(result.restored)} files`, {
          description: `${String(result.skippedMissing)} missing, ${String(result.failed)} failed.`,
        });
      } else {
        toast.success(`Restored ${String(result.restored)} files`);
      }
    } catch (err) {
      toast.error('Restore failed', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-subtle border-l-2 border-l-success bg-surface px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-2 text-body text-fg">
        <CheckCircle2
          className="size-4 shrink-0 text-success"
          strokeWidth={1.5}
          aria-hidden
        />
        <span className="truncate font-medium">
          Update mode active — {fileLabel} temporarily visible. Run your update tool, then restore.
        </span>
      </div>
      <Button variant="primary" size="sm" onClick={() => void onRestore()}>
        Restore curation
      </Button>
    </div>
  );
}
