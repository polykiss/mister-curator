import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { coreDisplayName } from '@shared/core-matching';

import { Button } from '@app/renderer/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { useCores } from '@app/renderer/src/contexts/CoresContext';
import { cn } from '@app/renderer/src/lib/cn';

interface SettingsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Controlled by BrowserScreen; keyed per-host in localStorage. */
  readonly showMameAsCores: boolean;
  readonly onShowMameAsCoresChange: (next: boolean) => void;
  /** Close settings and open the UpdateModeDialog. */
  readonly onOpenUpdateMode: () => void;
}

export function SettingsDialog({
  open,
  onOpenChange,
  showMameAsCores,
  onShowMameAsCoresChange,
  onOpenUpdateMode,
}: SettingsDialogProps): JSX.Element {
  const { currentProfile } = useConnection();
  const {
    autoHideEnabled,
    autoHidePending,
    setAutoHideEnabled,
    updateModeActive,
    auditResult,
    hideCore,
  } = useCores();

  const host = currentProfile?.host;

  const missingCoreFile = auditResult?.missingCoreFile ?? [];
  const noRomsForCore = auditResult?.noRomsForCore ?? [];
  const orphanArcadeRoms = auditResult?.orphanArcadeRoms ?? [];
  const hasIssues =
    missingCoreFile.length > 0 ||
    noRomsForCore.length > 0 ||
    orphanArcadeRoms.length > 0;
  const issueCount =
    missingCoreFile.length + noRomsForCore.length + orphanArcadeRoms.length;

  const onHideCore = async (coreId: string): Promise<void> => {
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
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          {host !== undefined ? (
            <DialogDescription>
              Settings for{' '}
              <span className="font-mono text-fg-body">{host}</span>
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="grid grid-cols-1 gap-6 pt-2 md:grid-cols-3">
          {/* Left column: settings controls */}
          <div className="col-span-1 space-y-6 overflow-y-auto max-h-[70vh] pr-1">
          {/* ── Display ───────────────────────────────────────────── */}
          <section>
            <h3 className="mb-3 text-caption font-semibold uppercase tracking-wider text-fg-muted">
              Display
            </h3>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="accent-accent mt-0.5 shrink-0"
                checked={showMameAsCores}
                onChange={(e) => onShowMameAsCoresChange(e.target.checked)}
              />
              <div>
                <div className="text-body-sm text-fg">
                  Show MAME / HBMame as separate cores
                </div>
                <div className="mt-0.5 text-caption text-fg-muted">
                  Manage arcade ZIP ROMs directly. Off by default; the
                  Arcade row covers the common case.
                </div>
              </div>
            </label>
          </section>

          {/* ── Arcade ────────────────────────────────────────────── */}
          <section>
            <h3 className="mb-3 text-caption font-semibold uppercase tracking-wider text-fg-muted">
              Arcade
            </h3>
            <label
              className={cn(
                'flex cursor-pointer items-start gap-3',
                (autoHidePending || autoHideEnabled === null) && 'opacity-60',
              )}
            >
              <input
                type="checkbox"
                className="accent-accent mt-0.5 shrink-0"
                checked={autoHideEnabled ?? false}
                disabled={autoHidePending || autoHideEnabled === null}
                onChange={(e) => void setAutoHideEnabled(e.target.checked)}
              />
              <div>
                <div className="flex items-center gap-1.5 text-body-sm text-fg">
                  Auto-hide missing ROMs
                  {autoHidePending ? (
                    <Loader2
                      className="size-3.5 animate-spin text-fg-muted"
                      strokeWidth={1.5}
                    />
                  ) : null}
                </div>
                <div className="mt-0.5 text-caption text-fg-muted">
                  Hides .mra entries whose ZIP is not present in
                  games/mame/ or games/hbmame/, keeping the MiSTer
                  arcade menu limited to what you can actually play.
                </div>
              </div>
            </label>
          </section>

          {/* ── System ────────────────────────────────────────────── */}
          <section>
            <h3 className="mb-3 text-caption font-semibold uppercase tracking-wider text-fg-muted">
              System
            </h3>
            <div>
              <Button
                variant="secondary"
                disabled={updateModeActive}
                onClick={() => {
                  onOpenChange(false);
                  onOpenUpdateMode();
                }}
              >
                <ShieldCheck strokeWidth={1.5} />
                Enter Update Mode
              </Button>
              <p className="mt-2 text-caption text-fg-muted">
                Temporarily reveals all hidden files so your MiSTer
                update tool can overwrite them without creating
                duplicates.
              </p>
              {updateModeActive ? (
                <p className="mt-1 text-caption text-fg-muted">
                  Update mode is currently active — use the banner to
                  restore first.
                </p>
              ) : null}
            </div>
          </section>
          </div>{/* end left column */}

          {/* Right column: diagnostics */}
          <div className="col-span-1 overflow-y-auto max-h-[70vh] md:col-span-2">
          {/* ── Diagnostics ───────────────────────────────────────── */}
          <section>
            <h3 className="mb-3 text-caption font-semibold uppercase tracking-wider text-fg-muted">
              {issueCount > 0
                ? `Diagnostics (${String(issueCount)})`
                : 'Diagnostics'}
            </h3>

            {!hasIssues ? (
              <div className="flex items-center gap-2 text-body-sm text-fg-muted">
                <CheckCircle2
                  className="size-4 shrink-0 text-success"
                  strokeWidth={1.5}
                />
                <span>No issues found.</span>
              </div>
            ) : (
              <div className="space-y-5">
                {missingCoreFile.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-body-sm font-medium text-fg">
                      Cores not installed ({String(missingCoreFile.length)})
                    </h4>
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
                  </div>
                )}

                {noRomsForCore.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-body-sm font-medium text-fg">
                      Cores with no ROMs ({String(noRomsForCore.length)})
                    </h4>
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
                          {noRomsForCore.map((core) => {
                            const first = core.rbfPaths[0];
                            const slash = first ? first.lastIndexOf('/') : -1;
                            const dir = first && slash > 0
                              ? first.slice(first.lastIndexOf('/', slash - 1) + 1, slash)
                              : '';
                            const file = first ? first.slice(slash + 1) : '—';
                            const rbfPath = dir ? `${dir}/${file}` : file;
                            return (
                              <tr
                                key={core.id}
                                className="border-b border-subtle last:border-0"
                              >
                                <td className="px-3 py-2 font-medium text-fg">
                                  {coreDisplayName(core.id)}
                                </td>
                                <td className="px-3 py-2 font-mono text-fg-muted">
                                  {rbfPath}
                                </td>
                                <td className="px-3 py-2">
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => void onHideCore(core.id)}
                                  >
                                    Hide
                                  </Button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-1.5 text-body-sm text-fg-muted">
                      Add ROMs or use <strong>Hide</strong> to remove from the
                      MiSTer menu.
                    </p>
                  </div>
                )}

                {orphanArcadeRoms.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-body-sm font-medium text-fg">
                      Orphan arcade ROMs ({String(orphanArcadeRoms.length)})
                    </h4>
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
                      on the MiSTer to install missing launchers, or delete
                      the ROMs to reclaim space.
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
          </div>{/* end right column */}
        </div>{/* end grid */}
      </DialogContent>
    </Dialog>
  );
}
