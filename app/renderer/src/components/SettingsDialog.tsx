import { Loader2, ShieldCheck } from 'lucide-react';
import type { JSX } from 'react';

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
  } = useCores();

  const host = currentProfile?.host;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          {host !== undefined ? (
            <DialogDescription>
              Settings for{' '}
              <span className="font-mono text-fg-body">{host}</span>
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="space-y-6 pt-2">
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
