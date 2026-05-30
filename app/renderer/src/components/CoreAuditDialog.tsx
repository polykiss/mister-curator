import { CheckCircle2 } from 'lucide-react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { coreDisplayName } from '@shared/core-matching';
import type { CoreEntry } from '@shared/types';

import { Button } from '@app/renderer/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@app/renderer/src/components/ui/dialog';
import { useCores } from '@app/renderer/src/contexts/CoresContext';

interface Props {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

function rbfShortPath(core: CoreEntry): string {
  const first = core.rbfPaths[0];
  if (!first) return '—';
  const slash = first.lastIndexOf('/');
  const dir = slash > 0 ? first.slice(first.lastIndexOf('/', slash - 1) + 1, slash) : '';
  const file = first.slice(slash + 1);
  return dir ? `${dir}/${file}` : file;
}

/**
 * feature/core-audit (#38) — modal showing two categories of mismatch
 * between installed cores and ROM directories:
 *
 *   "Cores not installed" — games dir with ROMs exists but no .rbf found.
 *   "Cores with no ROMs"  — .rbf installed but no games dir at all.
 *
 * Reads from CoresContext.auditResult which re-derives on every cores change
 * (hide/show, Refresh, connect) — no manual refresh needed.
 */
export function CoreAuditDialog({ open, onOpenChange }: Props): JSX.Element {
  const { auditResult, hideCore } = useCores();

  const missingCoreFile = auditResult?.missingCoreFile ?? [];
  const noRomsForCore = auditResult?.noRomsForCore ?? [];
  const orphanArcadeRoms = auditResult?.orphanArcadeRoms ?? [];
  const hasIssues =
    missingCoreFile.length > 0 ||
    noRomsForCore.length > 0 ||
    orphanArcadeRoms.length > 0;

  const onHide = async (coreId: string): Promise<void> => {
    try {
      await hideCore(coreId);
    } catch (err) {
      toast.error('Could not hide core', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Core health</DialogTitle>
          <DialogDescription>
            Audit of installed cores, ROM directories, and arcade ROMs.
          </DialogDescription>
        </DialogHeader>

        {!hasIssues ? (
          <div className="flex items-center justify-center gap-2 py-8 text-body text-fg-muted">
            <CheckCircle2 className="size-4 shrink-0 text-success" strokeWidth={1.5} />
            <span>Everything looks good.</span>
          </div>
        ) : (
          <div className="space-y-5">
            {missingCoreFile.length > 0 && (
              <section>
                <h3 className="mb-2 text-body font-medium text-fg">
                  Cores not installed ({String(missingCoreFile.length)})
                </h3>
                <div className="max-h-48 overflow-auto rounded border border-default">
                  <table className="w-full text-body-sm">
                    <thead className="sticky top-0 bg-overlay">
                      <tr className="border-b border-default text-left text-fg-muted">
                        <th className="px-3 py-2 font-medium">Core</th>
                        <th className="px-3 py-2 font-medium">Games dir</th>
                        <th className="px-3 py-2 text-right font-medium">ROMs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {missingCoreFile.map((core) => (
                        <tr
                          key={core.id}
                          className="border-b border-subtle last:border-0"
                        >
                          <td className="px-3 py-2 font-medium text-fg">
                            {coreDisplayName(core.id)}
                          </td>
                          <td className="px-3 py-2 font-mono text-fg-muted">
                            /media/fat/games/{core.gamesDirName ?? core.id}
                          </td>
                          <td className="px-3 py-2 text-right text-fg-muted">
                            {String(core.recursiveRomCount ?? core.romCount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 text-body-sm text-fg-muted">
                  Run{' '}
                  <code className="rounded border border-default bg-overlay px-1 font-mono text-body-sm">
                    update_all.sh
                  </code>{' '}
                  on the MiSTer to install missing cores.
                </p>
              </section>
            )}

            {noRomsForCore.length > 0 && (
              <section>
                <h3 className="mb-2 text-body font-medium text-fg">
                  Cores with no ROMs ({String(noRomsForCore.length)})
                </h3>
                <div className="max-h-48 overflow-auto rounded border border-default">
                  <table className="w-full text-body-sm">
                    <thead className="sticky top-0 bg-overlay">
                      <tr className="border-b border-default text-left text-fg-muted">
                        <th className="px-3 py-2 font-medium">Core</th>
                        <th className="px-3 py-2 font-medium">.rbf location</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {noRomsForCore.map((core) => (
                        <tr
                          key={core.id}
                          className="border-b border-subtle last:border-0"
                        >
                          <td className="px-3 py-2 font-medium text-fg">
                            {coreDisplayName(core.id)}
                          </td>
                          <td className="px-3 py-2 font-mono text-fg-muted">
                            {rbfShortPath(core)}
                          </td>
                          <td className="px-3 py-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                void onHide(core.id);
                              }}
                            >
                              Hide
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 text-body-sm text-fg-muted">
                  Add ROMs or use <strong>Hide</strong> to remove from the MiSTer menu.
                </p>
              </section>
            )}

            {orphanArcadeRoms.length > 0 && (
              <section>
                <h3 className="mb-2 text-body font-medium text-fg">
                  Orphan arcade ROMs ({String(orphanArcadeRoms.length)})
                </h3>
                <div className="max-h-48 overflow-auto rounded border border-default">
                  <table className="w-full text-body-sm">
                    <thead className="sticky top-0 bg-overlay">
                      <tr className="border-b border-default text-left text-fg-muted">
                        <th className="px-3 py-2 font-medium">File</th>
                        <th className="px-3 py-2 font-medium">Location</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orphanArcadeRoms.map((filename) => (
                        <tr
                          key={filename}
                          className="border-b border-subtle last:border-0"
                        >
                          <td className="px-3 py-2 font-mono text-fg">
                            {filename}
                          </td>
                          <td className="px-3 py-2 font-mono text-fg-muted">
                            games/mame/ or hbmame/
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 text-body-sm text-fg-muted">
                  These ROMs aren&apos;t referenced by any{' '}
                  <code className="rounded border border-default bg-overlay px-1 font-mono text-body-sm">
                    .mra
                  </code>{' '}
                  launcher. Run{' '}
                  <code className="rounded border border-default bg-overlay px-1 font-mono text-body-sm">
                    update_all.sh
                  </code>{' '}
                  on the MiSTer to install missing launchers, or delete the ROMs to reclaim space.
                </p>
              </section>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="subtle" onClick={() => { onOpenChange(false); }}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
