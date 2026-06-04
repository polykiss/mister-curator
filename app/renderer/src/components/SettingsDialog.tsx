import {
  Activity,
  ChevronDown,
  Gamepad2,
  Loader2,
  Monitor,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { toast } from 'sonner';

import { coreDisplayName } from '@shared/core-matching';

import { Button } from '@app/renderer/src/components/ui/button';
import { Switch } from '@app/renderer/src/components/ui/switch';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { useCores } from '@app/renderer/src/contexts/CoresContext';
import { cn } from '@app/renderer/src/lib/cn';

// D36: core-menu display modes
export type CoreMenuStyle = 'text' | 'logos' | 'images';

interface SettingsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Controlled by BrowserScreen; keyed per-host in localStorage. */
  readonly showMameAsCores: boolean;
  readonly onShowMameAsCoresChange: (next: boolean) => void;
  /** D36: how cores appear in the sidebar. */
  readonly coreMenuStyle: CoreMenuStyle;
  readonly onCoreMenuStyleChange: (next: CoreMenuStyle) => void;
  /** Close settings and open the UpdateModeDialog. */
  readonly onOpenUpdateMode: () => void;
}

export function SettingsDialog({
  open,
  onOpenChange,
  showMameAsCores,
  onShowMameAsCoresChange,
  coreMenuStyle,
  onCoreMenuStyleChange,
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
      {/* D35: 1040px bounded-height modal, no footer, custom close */}
      <DialogContent
        className={cn(
          'w-[1040px] max-w-[1040px]',
          'h-[min(88vh,672px)]',
          'rounded-[14px] bg-surface border border-default',
          'shadow-[0_40px_120px_-30px_rgba(0,0,0,0.8)]',
          'flex flex-col overflow-hidden',
          'p-0 gap-0',
        )}
        hideDefaultClose
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>

        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-start justify-between border-b border-subtle px-7 pb-[18px] pt-6">
          <div>
            <h2 className="text-2xl font-bold tracking-[-0.02em] text-fg" style={{ lineHeight: 1.1 }}>
              Settings
            </h2>
            {currentProfile !== null ? (
              <div className="mt-[5px] flex items-center gap-1.5 text-body-sm text-fg-muted">
                <span className="inline-block size-[6px] shrink-0 rounded-full bg-success" aria-hidden />
                <span className="text-fg-body">{currentProfile.name}</span>
                <span className="text-fg-disabled" aria-hidden>·</span>
                <span className="font-mono text-fg-body">{currentProfile.host}</span>
              </div>
            ) : null}
          </div>
          {/* Boxed 32×32 close button */}
          <DialogClose asChild>
            <button
              type="button"
              aria-label="Close"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-default text-fg-muted transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <X className="size-4" strokeWidth={2} />
            </button>
          </DialogClose>
        </div>

        {/* ── Body — 2-column grid ────────────────────────────────── */}
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_396px]">
          {/* LEFT — Settings controls */}
          <div className="flex flex-col gap-6 overflow-y-auto border-r border-subtle px-[30px] py-6">

            {/* DISPLAY section */}
            <section>
              <SectionLabel icon={<Monitor className="size-3.5" strokeWidth={1.7} />}>
                Display
              </SectionLabel>
              <div className="rounded-xl border border-subtle bg-canvas/40">
                {/* Core menu style — D36 */}
                <SettingRow
                  title="Core menu style"
                  description="How each core appears in the browser sidebar and on the MiSTer menu."
                  control={
                    <CoreMenuStyleSelect
                      value={coreMenuStyle}
                      onChange={onCoreMenuStyleChange}
                    />
                  }
                />
                <div className="border-t border-subtle" />
                {/* Show MAME / HBMame */}
                <SettingRow
                  title="Show MAME / HBMame as separate cores"
                  description="Manage arcade ZIP ROMs directly. Off by default; the Arcade row covers the common case."
                  control={
                    <Switch
                      className="mt-px shrink-0"
                      checked={showMameAsCores}
                      onCheckedChange={onShowMameAsCoresChange}
                    />
                  }
                />
              </div>
            </section>

            {/* ARCADE section */}
            <section>
              <SectionLabel icon={<Gamepad2 className="size-3.5" strokeWidth={1.7} />}>
                Arcade
              </SectionLabel>
              <div className="rounded-xl border border-subtle bg-canvas/40">
                <SettingRow
                  title="Auto-hide missing ROMs"
                  description={
                    <>
                      Hides <CodeChip>.mra</CodeChip> entries whose ZIP isn&apos;t present in{' '}
                      <CodeChip>games/mame/</CodeChip> or <CodeChip>games/hbmame/</CodeChip>.
                    </>
                  }
                  disabled={autoHidePending || autoHideEnabled === null}
                  control={
                    <Switch
                      className="mt-px shrink-0"
                      checked={autoHideEnabled ?? false}
                      disabled={autoHidePending || autoHideEnabled === null}
                      onCheckedChange={(v) => void setAutoHideEnabled(v)}
                    />
                  }
                  trailingIcon={
                    autoHidePending ? (
                      <Loader2 className="size-3.5 animate-spin text-fg-muted" strokeWidth={1.5} />
                    ) : null
                  }
                />
              </div>
            </section>

            {/* SYSTEM section */}
            <section>
              <SectionLabel icon={<ShieldCheck className="size-3.5" strokeWidth={1.7} />}>
                System
              </SectionLabel>
              <div className="rounded-xl border border-subtle bg-canvas/40 px-4 py-[15px]">
                <Button
                  variant="secondary"
                  disabled={updateModeActive}
                  className="h-[34px] rounded-lg border-emphasis px-[14px] text-[13px] font-medium hover:bg-elevated"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenUpdateMode();
                  }}
                >
                  <ShieldCheck className="size-4 text-accent" strokeWidth={1.5} />
                  Enter Update Mode
                </Button>
                <p className="mt-[11px] max-w-[36ch] text-[12px] leading-[1.5] text-fg-muted">
                  Temporarily reveals all hidden files so your MiSTer update tool can overwrite them without creating duplicates.
                </p>
                {updateModeActive ? (
                  <p className="mt-1 text-[12px] text-fg-muted">
                    Update mode is currently active — use the banner to restore first.
                  </p>
                ) : null}
              </div>
            </section>
          </div>

          {/* RIGHT — Diagnostics */}
          <div className="flex min-h-0 flex-col overflow-hidden bg-black/[0.13] px-7 py-6">
            {/* Diagnostics header */}
            <div className="mb-4 flex items-center gap-2.5">
              <SectionLabel icon={<Activity className="size-3.5" strokeWidth={1.7} />}>
                Diagnostics
              </SectionLabel>
              {hasIssues ? (
                <div className="flex items-center gap-1.5 text-[12px] tabular">
                  <span className="inline-block size-[6px] shrink-0 rounded-full bg-warning" aria-hidden />
                  <span className="font-bold text-fg">{String(issueCount)}</span>
                  <span className="text-fg-muted">issues</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-[12px]">
                  <span className="inline-block size-[6px] shrink-0 rounded-full bg-success" aria-hidden />
                  <span className="text-fg-muted">No issues</span>
                </div>
              )}
            </div>

            {!hasIssues ? (
              <p className="text-body-sm text-fg-muted">All systems nominal.</p>
            ) : (
              // Show first non-empty group; groups flex-fill the column
              <>
                {missingCoreFile.length > 0 && (
                  <DiagGroup
                    title="Cores not installed"
                    count={missingCoreFile.length}
                    table={
                      <table className="w-full">
                        <thead className="sticky top-0 bg-elevated">
                          <tr className="border-b border-default">
                            <DiagTh>Core</DiagTh>
                            <DiagTh>Games dir</DiagTh>
                            <DiagTh align="right">ROMs</DiagTh>
                          </tr>
                        </thead>
                        <tbody>
                          {missingCoreFile.map((core) => (
                            <tr key={core.id} className="border-b border-subtle last:border-0 hover:bg-elevated">
                              <DiagTd mono={false} className="font-medium text-fg-body">{coreDisplayName(core.id)}</DiagTd>
                              <DiagTd mono>/media/fat/games/{core.gamesDirName ?? core.id}</DiagTd>
                              <DiagTd mono align="right">{String(core.recursiveRomCount ?? core.romCount)}</DiagTd>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    }
                    footnote={
                      <>Run <CodeChip>update_all.sh</CodeChip> on the MiSTer to install missing cores.</>
                    }
                  />
                )}

                {noRomsForCore.length > 0 && (
                  <DiagGroup
                    title="Cores with no ROMs"
                    count={noRomsForCore.length}
                    table={
                      <table className="w-full">
                        <thead className="sticky top-0 bg-elevated">
                          <tr className="border-b border-default">
                            <DiagTh>Core</DiagTh>
                            <DiagTh>.rbf location</DiagTh>
                            <DiagTh />
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
                              <tr key={core.id} className="border-b border-subtle last:border-0 hover:bg-elevated">
                                <DiagTd mono={false} className="font-medium text-fg-body">{coreDisplayName(core.id)}</DiagTd>
                                <DiagTd mono>{rbfPath}</DiagTd>
                                <td className="px-[14px] py-[9px]">
                                  <Button variant="secondary" size="sm" onClick={() => void onHideCore(core.id)}>
                                    Hide
                                  </Button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    }
                    footnote={<>Add ROMs or use <strong>Hide</strong> to remove from the MiSTer menu.</>}
                  />
                )}

                {orphanArcadeRoms.length > 0 && (
                  <DiagGroup
                    title="Orphan arcade ROMs"
                    count={orphanArcadeRoms.length}
                    table={
                      <table className="w-full">
                        <thead className="sticky top-0 bg-elevated">
                          <tr className="border-b border-default">
                            <DiagTh>File</DiagTh>
                            <DiagTh>Location</DiagTh>
                          </tr>
                        </thead>
                        <tbody>
                          {orphanArcadeRoms.map((filename) => (
                            <tr key={filename} className="border-b border-subtle last:border-0 hover:bg-elevated">
                              <DiagTd mono>{filename}</DiagTd>
                              <DiagTd mono className="text-[12.5px]">games/mame/ or hbmame/</DiagTd>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    }
                    footnote={
                      <>
                        These ROMs aren&apos;t referenced by any <CodeChip>.mra</CodeChip> launcher.
                        Run <CodeChip>update_all.sh</CodeChip> on the MiSTer to install missing launchers,
                        or delete the ROMs to reclaim space.
                      </>
                    }
                  />
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Local helpers ────────────────────────────────────────────────────────────

/** Mono-caps section label with leading icon (D35). */
function SectionLabel({
  icon,
  children,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="mb-[14px] flex items-center gap-2 text-[11px] font-mono font-semibold uppercase tracking-[0.16em] text-fg-disabled">
      {icon}
      {children}
    </div>
  );
}

/** Inline code chip for paths / commands. */
function CodeChip({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <code className="rounded-[5px] border border-default bg-overlay px-[5px] py-px font-mono text-[12px] text-fg-body">
      {children}
    </code>
  );
}

/** Setting row inside a card. */
function SettingRow({
  title,
  description,
  control,
  disabled = false,
  trailingIcon,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly control: ReactNode;
  readonly disabled?: boolean;
  readonly trailingIcon?: ReactNode;
}): JSX.Element {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-4 py-[15px]', disabled && 'opacity-60')}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[13.5px] font-medium leading-[1.3] text-fg">
          {title}
          {trailingIcon}
        </div>
        <div className="mt-[5px] text-[12px] leading-[1.5] text-fg-muted">
          {description}
        </div>
      </div>
      {control}
    </div>
  );
}

/** Diagnostics issue group with flex-fill table. */
function DiagGroup({
  title,
  count,
  table,
  footnote,
}: {
  readonly title: string;
  readonly count: number;
  readonly table: ReactNode;
  readonly footnote: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Group title + count */}
      <div className="mb-[10px] flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-fg">{title}</span>
        <span className="font-mono text-[12px] text-fg-disabled">{String(count)}</span>
      </div>
      {/* Table — flex-fills remaining height */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-default">
        <div className="flex-1 overflow-y-auto">
          {table}
        </div>
      </div>
      {/* Footnote pinned below */}
      <p className="mt-[11px] shrink-0 text-[12.5px] leading-[1.55] text-fg-muted">
        {footnote}
      </p>
    </div>
  );
}

function DiagTh({
  children,
  align,
}: {
  readonly children?: ReactNode;
  readonly align?: 'right';
}): JSX.Element {
  return (
    <th
      className={cn(
        'sticky top-0 bg-elevated px-[14px] py-[9px]',
        'text-left font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-fg-disabled',
        align === 'right' && 'text-right',
      )}
    >
      {children}
    </th>
  );
}

function DiagTd({
  children,
  mono = true,
  align,
  className,
}: {
  readonly children?: ReactNode;
  readonly mono?: boolean;
  readonly align?: 'right';
  readonly className?: string;
}): JSX.Element {
  return (
    <td
      className={cn(
        'px-[14px] py-[9px] text-[13px]',
        mono && 'font-mono text-fg-muted',
        align === 'right' && 'text-right',
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Core-menu-style native select styled to the comp (D36). */
function CoreMenuStyleSelect({
  value,
  onChange,
}: {
  readonly value: CoreMenuStyle;
  readonly onChange: (next: CoreMenuStyle) => void;
}): JSX.Element {
  return (
    <div className="relative mt-px shrink-0">
      <select
        value={value}
        onChange={(e) => { onChange(e.target.value as CoreMenuStyle); }}
        className={cn(
          'h-[34px] min-w-[172px] appearance-none cursor-pointer',
          'rounded-lg border border-emphasis bg-overlay',
          'pl-3 pr-9 text-[13px] font-medium text-fg',
          'hover:border-fg-disabled focus:border-accent focus:outline-none',
          'transition-colors',
        )}
        aria-label="Core menu style"
      >
        <option value="text" className="bg-overlay text-fg">Text only</option>
        <option value="logos" className="bg-overlay text-fg">System logos</option>
        <option value="images" className="bg-overlay text-fg">System images</option>
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-[11px] top-1/2 size-3.5 -translate-y-1/2 text-fg-muted"
        strokeWidth={1.5}
        aria-hidden
      />
    </div>
  );
}
