import { Eye, EyeOff, Loader2, Sparkles, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import type { AutoScrapeProgressEvent, SystemCatalogWireEntry } from '@shared/preload-api';
import { decodeIpcError, isDestinationAlreadyExistsError } from '@shared/preload-api';
import { aliasTargetsToSuppress } from '@shared/core-audit';
import { coreDisplayName, isCoreHidden } from '@shared/core-matching';
import type { CoreEntry } from '@shared/types';

import { CoreInfoDialog } from '@app/renderer/src/components/CoreInfoDialog';
import { CoreLogo } from '@app/renderer/src/components/CoreLogo';
import { CoreRenameDialog } from '@app/renderer/src/components/CoreRenameDialog';
import type { RomRowMenuItem } from '@app/renderer/src/components/RomRowMenu';
import { RomRowMenu } from '@app/renderer/src/components/RomRowMenu';
import { useCoreCustomNames } from '@app/renderer/src/lib/use-core-custom-names';

import { Button } from '@app/renderer/src/components/ui/button';
import { DensityBar } from '@app/renderer/src/components/ui/density-bar';
import { StatusIndicator } from '@app/renderer/src/components/ui/status-indicator';
import { HideEmptyCoresDialog } from '@app/renderer/src/components/HideEmptyCoresDialog';
import { Skeleton } from '@app/renderer/src/components/ui/skeleton';
import { useAutoScrapeProgress } from '@app/renderer/src/contexts/AutoScrapeContext';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { useCores } from '@app/renderer/src/contexts/CoresContext';
import { cn } from '@app/renderer/src/lib/cn';
import { summarizeBulkResult } from '@app/renderer/src/lib/format';
import { usePersistedBool } from '@app/renderer/src/lib/use-persisted-bool';

const DISCONNECTED_TOOLTIP = 'Reconnect to make changes.';

export function CoresPane(): JSX.Element {
  const {
    cores,
    coresLoading,
    coresError,
    selectedCoreId,
    selectCore,
    hideCore,
    showCore,
    setBulkCoreVisibility,
    pendingCoreIds,
    ledgerCoreIds,
  } = useCores();
  const { status } = useConnection();
  const canMutate = status === 'connected';
  // fix/count-and-status-indicator commit 2 — passes the full
  // auto-scrape event so per-core progress can be computed inline
  // (replaces the old "scrapedCoreIds Set + green ✓" binary view).
  const autoScrapeProgress = useAutoScrapeProgress();

  // Hidden cores stay off the default cores list — they're permanent
  // decisions and the user opts in to seeing them.
  const [showHidden, setShowHidden] = usePersistedBool(
    'mistercurator.showHiddenCores',
    false,
  );
  // feat/arcade-parity-3-ui (G23) — MAME/HBMame manage .zip ROMs that
  // are mostly arcade BIOS / parent-set storage. The Arcade pane (driven
  // by .mra files in `_Arcade/`) is the real user-facing surface; the
  // .zip-management view is power-user territory. Off by default so the
  // sidebar reads as one Arcade row; the toggle restores both cores for
  // anyone who manages their MAME/HBMame zips directly.
  const [showMameAsCores, setShowMameAsCores] = usePersistedBool(
    'mistercurator.showMameAsCores',
    false,
  );
  const [bulkOpen, setBulkOpen] = useState(false);

  // feat/core-context-menu-and-info-dialog (#30 PR-2)
  const [menuFor, setMenuFor] = useState<{
    core: CoreEntry;
    x: number;
    y: number;
  } | null>(null);
  const [infoFor, setInfoFor] = useState<CoreEntry | null>(null);
  const [renameFor, setRenameFor] = useState<CoreEntry | null>(null);
  const [systemCatalog, setSystemCatalog] = useState<Record<
    string,
    SystemCatalogWireEntry
  > | null>(null);
  const [rescrapeInFlight, setRescrapeInFlight] = useState<ReadonlySet<string>>(
    new Set(),
  );

  // feat/sidebar-logos-and-naming (#30 PR-3) — eager catalog load on
  // mount, with retry logic so a cold-cache scenario (catalog being
  // freshly fetched from SS on the main side) doesn't strand the
  // sidebar on null forever.
  //
  // fix/core-info-dialog-v2-regressions — added status dep + bounded
  // retry. The original one-shot fetch returned null when ensureCatalog()
  // was still in-flight; now we also retry on each 'connected' transition
  // and back-off-retry up to MAX_ATTEMPTS times.
  const MAX_CATALOG_ATTEMPTS = 10;
  const CATALOG_RETRY_MS = 1500;

  useEffect(() => {
    if (systemCatalog !== null) return;
    let cancelled = false;
    let attempt = 0;

    const fetchOnce = async (): Promise<void> => {
      if (cancelled || systemCatalog !== null) return;
      attempt += 1;
      try {
        const result = await window.mister.getSystemCatalog();
        if (cancelled) return;
        if (result !== null) {
          setSystemCatalog(result);
          return;
        }
      } catch {
        // network/ipc error — fall through to retry
      }
      if (attempt < MAX_CATALOG_ATTEMPTS) {
        setTimeout(() => { void fetchOnce(); }, CATALOG_RETRY_MS);
      } else if (!cancelled) {
        setSystemCatalog({});
      }
    };

    void fetchOnce();
    return () => { cancelled = true; };
  // Re-trigger on every 'connected' transition so reconnects pick up
  // the catalog even if it wasn't ready on the initial mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]); // intentionally omit systemCatalog to avoid restart loop

  const customNames = useCoreCustomNames();

  const buildMenuItems = (core: CoreEntry): readonly RomRowMenuItem[] => {
    const entry = systemCatalog?.[core.id] ?? null;
    const hasLogo = entry !== null && entry.logoUrl !== null;
    const isInFlight = rescrapeInFlight.has(core.id);
    const hasCustom = customNames.customName(core.id) !== null;

    return [
      {
        label: 'Rename…',
        onSelect: () => {
          setMenuFor(null);
          setRenameFor(core);
        },
      },
      ...(hasCustom
        ? [{
            label: 'Reset name',
            onSelect: () => {
              setMenuFor(null);
              customNames.clearCustomName(core.id);
              toast.success('Name reset');
            },
          }]
        : []),
      {
        label: 'Show core info…',
        onSelect: () => {
          setInfoFor(core);
          setMenuFor(null);
        },
      },
      {
        label: isInFlight ? 'Rescraping…' : 'Rescrape system',
        disabled: !hasLogo || isInFlight,
        title: !hasLogo ? 'No ScreenScraper coverage for this system' : undefined,
        onSelect: () => {
          if (!entry || entry.logoUrl === null) return;
          setMenuFor(null);
          setRescrapeInFlight((s) => new Set([...s, core.id]));
          void (async () => {
            try {
              const result = await window.mister.rescrapeSystemLogo(entry.logoUrl!);
              if (result === null) {
                toast.error('Rescrape failed', {
                  description: 'Could not fetch logo — check your network.',
                });
              } else {
                toast.success(`Rescraped ${entry.displayName}`);
              }
            } catch (err) {
              toast.error('Rescrape failed', {
                description: err instanceof Error ? err.message : String(err),
              });
            } finally {
              setRescrapeInFlight((s) => {
                const next = new Set(s);
                next.delete(core.id);
                return next;
              });
            }
          })();
        },
      },
    ];
  };

  // feat/sidebar-alias-dedup (#48) — canonical rbf-name cores (e.g.
  // TurboGrafx16, Minimig) that are empty while an alias source
  // (TGFX16, Amiga, etc.) has content. Computed once and shared by
  // both visibleCores and emptyHideableCores so the count stays in sync.
  const suppressedAliasTargetIds = useMemo(
    () => aliasTargetsToSuppress(cores ?? []),
    [cores],
  );

  const visibleCores = useMemo(() => {
    if (!cores) return null;
    const hiddenFiltered = showHidden
      ? cores
      : cores.filter((c) => c.category === 'Arcade' || !isCoreHidden(c));
    const aliasFiltered = hiddenFiltered.filter(
      (c) => !suppressedAliasTargetIds.has(c.id),
    );
    const mameFiltered = showMameAsCores
      ? aliasFiltered
      : aliasFiltered.filter((c) => c.id !== 'mame' && c.id !== 'hbmame');
    const resolveName = (c: CoreEntry): string =>
      customNames.customName(c.id) ?? systemCatalog?.[c.id]?.displayName ?? coreDisplayName(c.id);
    return [...mameFiltered].sort((a, b) =>
      resolveName(a).localeCompare(resolveName(b), undefined, { sensitivity: 'base' }),
    );
  }, [cores, showHidden, showMameAsCores, suppressedAliasTargetIds, customNames, systemCatalog]);

  const emptyHideableCores = useMemo(() => {
    const resolveName = (c: CoreEntry): string =>
      customNames.customName(c.id) ?? systemCatalog?.[c.id]?.displayName ?? coreDisplayName(c.id);
    return (cores ?? [])
      .filter(
        (c) =>
          c.romCount === 0 &&
          c.category !== 'Arcade' &&
          !isCoreHidden(c) &&
          !suppressedAliasTargetIds.has(c.id),
      )
      .sort((a, b) => resolveName(a).localeCompare(resolveName(b), undefined, { sensitivity: 'base' }));
  }, [cores, suppressedAliasTargetIds, customNames, systemCatalog]);

  // "Unhide all (N)" only targets cores in the on-MiSTer ledger — the
  // ones we hid ourselves. Other dot-prefixed cores (firmware system
  // folders, externally-hidden cases) stay alone unless the user
  // unhides them one at a time via the eye icon.
  const appHiddenCores = useMemo(
    () =>
      (cores ?? []).filter(
        (c) =>
          isCoreHidden(c) &&
          c.category !== 'Arcade' &&
          ledgerCoreIds.has(c.id),
      ),
    [cores, ledgerCoreIds],
  );

  const onHide = async (core: CoreEntry): Promise<void> => {
    try {
      await hideCore(core.id);
      toast.success(`Hid ${coreDisplayName(core.id)}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await showCore(core.id);
                toast.success(`Restored ${coreDisplayName(core.id)}`);
              } catch (err) {
                toast.error('Could not restore core', {
                  description: err instanceof Error ? err.message : 'Unexpected error.',
                });
              }
            })();
          },
        },
        duration: 10000,
      });
    } catch (err) {
      const decoded = decodeIpcError(err);
      if (isDestinationAlreadyExistsError(decoded)) {
        toast.error(`Couldn't hide ${coreDisplayName(core.id)}`, {
          description:
            'A previous hidden copy already exists on the device — likely left by a MiSTer update. Manual cleanup via SSH is needed. (Restore flow coming in a future update.)',
        });
      } else {
        toast.error(`Could not hide ${coreDisplayName(core.id)}`, {
          description: decoded instanceof Error ? decoded.message : 'Unexpected error.',
        });
      }
    }
  };

  const onShow = async (core: CoreEntry): Promise<void> => {
    try {
      await showCore(core.id);
      toast.success(`Restored ${coreDisplayName(core.id)}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await hideCore(core.id);
              } catch {
                /* swallow — primary toast was the success */
              }
            })();
          },
        },
        duration: 10000,
      });
    } catch (err) {
      const decoded = decodeIpcError(err);
      if (isDestinationAlreadyExistsError(decoded)) {
        toast.error(`Couldn't show ${coreDisplayName(core.id)}`, {
          description:
            'A visible copy already exists on the device alongside the hidden one. Manual cleanup via SSH is needed. (Restore flow coming in a future update.)',
        });
      } else {
        toast.error(`Could not show ${coreDisplayName(core.id)}`, {
          description: decoded instanceof Error ? decoded.message : 'Unexpected error.',
        });
      }
    }
  };

  const onShowAllHidden = async (): Promise<void> => {
    if (appHiddenCores.length === 0) return;
    const changes = appHiddenCores.map((c) => ({ coreId: c.id, hidden: false }));
    try {
      const result = await setBulkCoreVisibility(changes);
      const summary = summarizeBulkResult({
        action: 'Restored',
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
                        result.succeeded.map((id) => ({ coreId: id, hidden: true })),
                      );
                    } catch {
                      /* swallow */
                    }
                  })();
                },
              }
            : undefined,
        duration: 10000,
      });
    } catch (err) {
      toast.error('Could not unhide all cores', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex flex-col gap-3 border-b border-subtle px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setBulkOpen(true)}
            disabled={!canMutate || emptyHideableCores.length === 0}
            title={canMutate ? undefined : DISCONNECTED_TOOLTIP}
          >
            <Sparkles strokeWidth={1.5} />
            Hide empty ({emptyHideableCores.length})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onShowAllHidden()}
            disabled={!canMutate || appHiddenCores.length === 0}
            title={
              canMutate
                ? 'Restore visibility for every core MiSTerCurator hid'
                : DISCONNECTED_TOOLTIP
            }
          >
            <Undo2 strokeWidth={1.5} />
            Unhide all ({appHiddenCores.length})
          </Button>
        </div>
        <div className="flex flex-wrap gap-4 text-body-sm text-fg-body">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-accent"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Show hidden
          </label>
          <label
            className="flex items-center gap-2"
            title="MAME / HBMame manage .zip ROMs that mostly feed the Arcade pane. Off by default so the sidebar shows one Arcade row; turn on to manage the zips directly."
          >
            <input
              type="checkbox"
              className="accent-accent"
              checked={showMameAsCores}
              onChange={(e) => setShowMameAsCores(e.target.checked)}
            />
            Show MAME / HBMame as separate cores
          </label>
        </div>
      </header>

      {renderCoreList({
        cores,
        coresLoading,
        coresError,
        visibleCores,
        selectedCoreId,
        pendingCoreIds,
        autoScrapeProgress,
        canMutate,
        catalog: systemCatalog,
        customNames,
        onSelect: selectCore,
        onHide,
        onShow,
        onContextMenu: (core, x, y) => { setMenuFor({ core, x, y }); },
      })}

      <HideEmptyCoresDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        candidates={emptyHideableCores}
      />

      {menuFor !== null ? (
        <RomRowMenu
          x={menuFor.x}
          y={menuFor.y}
          items={buildMenuItems(menuFor.core)}
          onClose={() => { setMenuFor(null); }}
        />
      ) : null}

      <CoreInfoDialog
        core={infoFor}
        catalog={systemCatalog}
        open={infoFor !== null}
        onOpenChange={(open) => { if (!open) setInfoFor(null); }}
      />

      <CoreRenameDialog
        key={renameFor?.id ?? 'none'}
        core={renameFor}
        ssDisplayName={renameFor !== null ? (systemCatalog?.[renameFor.id]?.displayName ?? null) : null}
        currentCustomName={renameFor !== null ? customNames.customName(renameFor.id) : null}
        open={renameFor !== null}
        onOpenChange={(open) => { if (!open) setRenameFor(null); }}
        onSave={(name) => {
          if (renameFor === null) return;
          if (name.trim().length === 0) {
            customNames.clearCustomName(renameFor.id);
          } else {
            customNames.setCustomName(renameFor.id, name.trim());
          }
          setRenameFor(null);
        }}
      />
    </div>
  );
}

interface RenderArgs {
  readonly cores: readonly CoreEntry[] | null;
  readonly coresLoading: boolean;
  readonly coresError: string | null;
  readonly visibleCores: readonly CoreEntry[] | null;
  readonly selectedCoreId: string | null;
  readonly pendingCoreIds: ReadonlySet<string>;
  /**
   * fix/count-and-status-indicator commit 2 — full auto-scrape
   * event. Per-row code derives the StatusIndicator's progress
   * inline: 1.0 for cores in `completedCoreIds`, `done/total` for
   * the active core, 0 otherwise. Replaces the prior
   * `scrapedCoreIds Set` which carried only the binary state.
   */
  readonly autoScrapeProgress: AutoScrapeProgressEvent;
  readonly canMutate: boolean;
  readonly catalog: Record<string, SystemCatalogWireEntry> | null;
  readonly customNames: {
    customName: (coreId: string) => string | null;
    setCustomName: (coreId: string, name: string) => void;
    clearCustomName: (coreId: string) => void;
  };
  readonly onSelect: (id: string | null) => void;
  readonly onHide: (core: CoreEntry) => Promise<void>;
  readonly onShow: (core: CoreEntry) => Promise<void>;
  readonly onContextMenu: (core: CoreEntry, x: number, y: number) => void;
}

/**
 * Pure derivation of per-core scrape progress from the latest
 * AutoScrapeProgressEvent. Exported so tests can pin the shape
 * (each branch of the indicator's gradient state machine maps
 * directly to one of these return values).
 */
export function progressForCore(
  coreId: string,
  event: AutoScrapeProgressEvent,
): number {
  if (event.completedCoreIds.includes(coreId)) return 1;
  if (event.state === 'active' && event.coreId === coreId) {
    if (event.total <= 0) return 0;
    const ratio = event.done / event.total;
    if (ratio < 0) return 0;
    if (ratio > 1) return 1;
    return ratio;
  }
  return 0;
}

function renderCoreList(args: RenderArgs): JSX.Element {
  if (args.coresLoading && args.cores === null) {
    return (
      <div className="space-y-1 p-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (args.coresError !== null) {
    return (
      <div className="border-l-2 border-destructive bg-surface p-4 text-body-sm text-fg-body">
        {args.coresError}
      </div>
    );
  }

  if (!args.visibleCores || args.visibleCores.length === 0) {
    return (
      <div className="p-6 text-body-sm text-fg-muted">No cores found.</div>
    );
  }

  // Density-bar denominator: max recursive ROM count across the
  // visible cores. Recursive values let NEOGEO's ~300 stand against
  // mame's 633 instead of NEOGEO's top-level "9" collapsing into the
  // floor. Falls back to top-level `romCount` when the matcher
  // didn't supply a recursive value (legacy fixtures, partial test
  // data).
  const maxRomCount = args.visibleCores.reduce((acc, c) => {
    const v = densityValueFor(c);
    return v > acc ? v : acc;
  }, 0);

  return (
    <ul
      // PR #23 round 5 commit 1: `scroll-themed` reserves a stable
      // scrollbar gutter and paints a permanent themed bar so native
      // overlay scrollbars on macOS can't fade in over the eye column.
      // PR #23 round 6: `pr-2.5` (10px) forces explicit breathing
      // room on the right of the row content so the eye buttons sit
      // ≥10px from the scroll container's padding-box right edge —
      // well clear of the scrollbar's drawn position regardless of
      // how the gutter reservation actually resolves (overlay vs
      // classic, etc.). The right-edge density bar shifts inward
      // by the same 10px; the "continuous strip on the right" still
      // reads as continuous against the visible list edge.
      className="scroll-themed flex-1 overflow-auto pr-2.5"
      role="listbox"
      aria-label="MiSTer cores"
    >
      {args.visibleCores.map((core) => {
        const isSelected = core.id === args.selectedCoreId;
        const isHiddenCore = isCoreHidden(core);
        const isArcade = core.category === 'Arcade';
        const isPending = args.pendingCoreIds.has(core.id);
        const catalogEntry = args.catalog?.[core.id] ?? null;
        const technicalId = coreDisplayName(core.id);
        const customName = args.customNames.customName(core.id);
        const displayName = customName ?? catalogEntry?.displayName ?? technicalId;
        const showSubtitle = displayName !== technicalId;

        return (
          <li
            key={core.id}
            className={cn(
              'group/row relative flex h-14 items-center gap-3 border-b border-subtle pl-4 text-body transition-colors',
              !isSelected && 'hover:bg-elevated',
              isSelected && 'bg-overlay',
              // Hidden rows lean entirely on dimming: opacity +
              // italic + a darker text color.
              isHiddenCore && 'opacity-50 italic text-fg-disabled',
            )}
            onContextMenu={(e) => {
              e.preventDefault();
              args.onContextMenu(core, e.clientX, e.clientY);
            }}
          >
            {/* Active row: 2px accent edge per SYSTEM.md §5. Renders
                inside the row container so it doesn't shift content. */}
            {isSelected ? (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-[2px] bg-accent"
              />
            ) : null}

            <button
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => args.onSelect(core.id)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none"
            >
              {/* fix/count-and-status-indicator commit 2 — placed before
                  the logo so the indicator column stays fixed. */}
              <StatusIndicator
                progress={progressForCore(core.id, args.autoScrapeProgress)}
                sizePx={12}
                ariaLabel={`Scrape progress for ${displayName}`}
              />

              <CoreLogo url={catalogEntry?.logoUrl ?? null} />

              <div className="flex min-w-0 flex-col items-start">
                <span
                  className={cn(
                    'w-full truncate',
                    isSelected && !isHiddenCore && 'font-medium text-fg',
                  )}
                  title={displayName}
                >
                  {displayName}
                </span>
                {showSubtitle && (
                  <span className="w-full truncate text-body-sm text-fg-muted">
                    {technicalId}
                  </span>
                )}
              </div>

              <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-body-sm text-fg-muted tabular">
                <CoreCountSummary core={core} />
              </span>
            </button>

            {/* Right-edge stack: density rectangle flush against the
                eye icon on the far right. Wrapping them in a
                gap-0 flex lets the density's right edge meet the
                button's left edge with no breathing room — matches
                the ROMs pane's identical right-edge stack. The
                surrounding `<li>` keeps `gap-2` for the spacing
                between the name area and this stack. */}
            <div className="flex h-full shrink-0 items-stretch">
              <DensityBar
                floor="bg-surface"
                value={densityValueFor(core)}
                max={maxRomCount}
                ariaLabel={`${String(densityValueFor(core))} ROMs of peer max ${String(maxRomCount)}`}
              />
              {isArcade ? (
                // feat/arcade-phase-1.5 — the synthetic Arcade row
                // is now navigable (clicking surfaces the .mra
                // listing for hide/unhide). Hide is per-`.mra`,
                // not per-row, so no eye icon at this level.
                //
                // feat/arcade-sidebar-alignment — reserve the eye-
                // icon slot's footprint (`h-8 w-8`) as an inert
                // spacer instead of rendering `null`. Without the
                // placeholder, the density bar sat ~32px to the
                // right of where it sits on every other core row,
                // visibly mis-aligning the Arcade strip in the
                // sidebar. Same width as the `Button size="icon"`
                // + loading-spinner span so the column grid stays
                // identical across all row variants.
                <span
                  aria-hidden
                  data-arcade-eye-slot
                  className="block h-8 w-8 shrink-0 self-center"
                />
              ) : isPending ? (
                // Inline indicator while the SSH rename is on the
                // wire (Round 5 Issue 4). Replaces the eye icon at
                // the same screen position so the row's
                // optimistic state-flip is paired with a clear
                // "we're working on it" signal.
                <span
                  role="status"
                  aria-label={
                    isHiddenCore ? `Showing ${coreDisplayName(core.id)}…` : `Hiding ${coreDisplayName(core.id)}…`
                  }
                  className="flex h-8 w-8 shrink-0 items-center justify-center self-center text-fg-muted"
                >
                  <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
                </span>
              ) : isHiddenCore ? (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void args.onShow(core)}
                  disabled={!args.canMutate}
                  title={
                    args.canMutate ? `Show ${coreDisplayName(core.id)}` : DISCONNECTED_TOOLTIP
                  }
                  aria-label={`Show ${coreDisplayName(core.id)}`}
                  className="self-center opacity-70 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                >
                  <EyeOff strokeWidth={1.5} />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void args.onHide(core)}
                  disabled={!args.canMutate}
                  title={
                    args.canMutate ? `Hide ${coreDisplayName(core.id)}` : DISCONNECTED_TOOLTIP
                  }
                  aria-label={`Hide ${coreDisplayName(core.id)}`}
                  className={cn(
                    'self-center transition-opacity',
                    !isSelected &&
                      'opacity-70 group-hover/row:opacity-100 focus-visible:opacity-100',
                  )}
                >
                  <Eye strokeWidth={1.5} />
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Value the cores-list density indicator uses for `value`. Prefers
 * the recursive ROM count when the matcher computed it (the cores
 * with containers — NEOGEO, MegaCD, Saturn, ...). Falls back to the
 * top-level `romCount` when the matcher input lacked sub-folder data.
 */
function densityValueFor(core: CoreEntry): number {
  return core.recursiveRomCount ?? core.romCount;
}

/**
 * Cores-list count summary. PR-B (PR #24): one exact integer per core
 * — the recursive-walk launchable-ROM count from the matcher.
 *
 * fix/scrape-and-count-correctness commit 5:
 *   • The hidden-count parenthetical drops the "hidden" word — the
 *     muted dim-grey paren is the visual cue, the count is the
 *     payload. PR #38 commit 3 originally dropped the word; a later
 *     refactor brought it back. Pinned via test now.
 *   • Both numerator and parenthetical pull from `recursive*Count`,
 *     so "100 (50)" reports "50 of those 100 total are hidden" with
 *     a consistent basis. Pre-fix the parenthetical drew from
 *     `hiddenCount` (top-level only) while the visible total drew
 *     from `recursiveRomCount` (whole walk) — incoherent for cores
 *     with hidden ROMs nested inside container subfolders.
 */
export function CoreCountSummary({ core }: { readonly core: CoreEntry }): JSX.Element {
  const total = core.recursiveRomCount ?? core.romCount;
  // feat/arcade-ux-and-ledger (PR 2/2) — for the Arcade synthetic
  // row only, render `playable (total)` instead of the usual
  // `total (hidden)`. The arcadePlayableCount field is undefined
  // everywhere else AND on the Arcade row before the playability
  // scan resolves; both fall through to the legacy display.
  if (core.arcadePlayableCount !== undefined) {
    return (
      <>
        <span className="min-w-[2.5rem] text-right">{core.arcadePlayableCount}</span>
        <span className="text-fg-disabled">({total})</span>
      </>
    );
  }
  const hidden = core.recursiveHiddenCount ?? core.hiddenCount;
  return (
    <>
      <span className="min-w-[2.5rem] text-right">{total}</span>
      {hidden > 0 ? (
        <span className="text-fg-disabled">({hidden})</span>
      ) : null}
    </>
  );
}
