import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import type { ArcadeMraEntry } from '@shared/arcade-mra';
import { arcadeMraVisiblePath } from '@shared/ledger';
import type {
  ArcadeMraEntryWire,
  ArcadePlayabilityWire,
} from '@shared/preload-api';

import { Button } from '@app/renderer/src/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@app/renderer/src/components/ui/table';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { cn } from '@app/renderer/src/lib/cn';
import { summarizeBulkResult } from '@app/renderer/src/lib/format';
import { usePersistedBool } from '@app/renderer/src/lib/use-persisted-bool';

/**
 * feat/arcade-phase-1.5 — pane for managing `.mra` files under
 * `_Arcade/`. Distinct from RomsPane (which is heavy with metadata
 * + sort + drilling + system-file marks); this is a focused
 * listing + hide/unhide surface.
 *
 * PR 2/2 (feat/arcade-ux-and-ledger) layers on:
 *   • MISSING ROMS pill per row sourced from `getArcadePlayability`.
 *   • "Auto-hide missing ROMs" persisted checkbox in the header,
 *     backed by the per-host ledger (default ON). Flipping it
 *     runs the rule diff via setArcadeAutoHideEnabled.
 *   • Three-state eye-toggle tooltip: "Hide" / "Show (you hid this)"
 *     / "Show (auto-hidden because ROMs are missing)".
 *   • Tombstoned-shown rows still surface the MISSING ROMS pill
 *     (the .mra still has missing ROMs — the user chose to keep
 *     it visible anyway).
 */
export function ArcadeMraPane(): JSX.Element {
  const { status } = useConnection();
  const canMutate = status === 'connected';

  const [entries, setEntries] = useState<readonly ArcadeMraEntry[] | null>(
    null,
  );
  const [playability, setPlayability] =
    useState<ArcadePlayabilityWire | null>(null);
  const [autoHideEnabled, setAutoHideEnabled] = useState<boolean | null>(null);
  const [autoHidePending, setAutoHidePending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // PR 2/2 — default OFF so the pane visually matches what the
  // firmware menu shows. Pre-2/2 this defaulted ON because the
  // typical user hadn't hidden many .mras and seeing them dimmed
  // gave a "manage everything" surface. With auto-hide ON-by-
  // default, a typical install has 100+ hidden .mras and a
  // showHidden=true default looks identical to no-rule-applied —
  // confusing in live verify. The user can flip this on at any
  // time to manage the hidden set; the storage key matches the
  // pre-2/2 one so existing user preferences carry over.
  const [showHidden, setShowHidden] = usePersistedBool(
    'mistercurator.showHiddenArcadeMras',
    false,
  );

  const refresh = useCallback(
    async (forceRefresh = false): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        // Fetch entries + playability in parallel. Auto-hide
        // preference rarely changes between calls; we still
        // refresh it here so a multi-window state change shows up.
        const [wire, play, enabled] = await Promise.all([
          window.mister.listArcadeMraEntries({ forceRefresh }),
          window.mister.getArcadePlayability(),
          window.mister.getArcadeAutoHideEnabled(),
        ]);
        setEntries(wireToEntries(wire));
        setPlayability(play);
        setAutoHideEnabled(enabled);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to load arcade entries.';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  // Top-level `.mra` rows only. PR 2/2 scope is "top-level mras";
  // nested mras (under `_alternatives/` or user-organisational
  // subfolders) are not playability-scanned and don't carry a
  // missing-ROM badge, so surfacing them in this listing would
  // give a false impression that they're "fine" when in fact we
  // never checked. Phase 3 will add a drillable view + per-row
  // metadata for nested mras. Subfolder rows (`kind` !== 'mra')
  // were already filtered pre-2/2 — they were navigational
  // placeholders for a hierarchical view that hasn't been built.
  const mraRows = useMemo(() => {
    if (entries === null) return [];
    return entries.filter(
      (e) => e.kind === 'mra' && !e.relativePath.includes('/'),
    );
  }, [entries]);

  /**
   * relativePath → 'playable' | 'missing' | 'no-roms-needed'.
   * Lookups in the row render path; precomputed once per refresh.
   */
  const playabilityByPath = useMemo(() => {
    const map = new Map<string, 'playable' | 'missing' | 'no-roms-needed'>();
    if (playability === null) return map;
    for (const p of playability.playable) map.set(p, 'playable');
    for (const p of playability.missing) map.set(p, 'missing');
    for (const p of playability.noRomsNeeded) map.set(p, 'no-roms-needed');
    return map;
  }, [playability]);

  /**
   * Visible-path Set of every entry the auto-hide rule has put into
   * hidden state. Used for the eye-toggle tooltip to differentiate
   * "auto-hidden because of missing ROMs" from "you hid this".
   */
  const autoHiddenSet = useMemo(() => {
    return new Set(playability?.autoHidden ?? []);
  }, [playability]);

  const presentable = useMemo(
    () => (showHidden ? mraRows : mraRows.filter((e) => !e.hidden)),
    [mraRows, showHidden],
  );

  const visibleCount = mraRows.filter((e) => !e.hidden).length;
  const hiddenCount = mraRows.filter((e) => e.hidden).length;

  const onToggleSingle = async (entry: ArcadeMraEntry): Promise<void> => {
    if (!canMutate) return;
    const next = !entry.hidden;
    setPendingPaths((prev) => {
      const out = new Set(prev);
      out.add(entry.relativePath);
      return out;
    });
    try {
      await window.mister.setArcadeMraVisibility(entry.relativePath, next);
      await refresh(true);
    } catch (err) {
      toast.error(
        `Could not ${next ? 'hide' : 'show'} ${entry.displayName}`,
        {
          description: err instanceof Error ? err.message : 'Unexpected error.',
        },
      );
    } finally {
      setPendingPaths((prev) => {
        const out = new Set(prev);
        out.delete(entry.relativePath);
        return out;
      });
    }
  };

  const runBulk = async (target: 'hide' | 'show'): Promise<void> => {
    const changes = mraRows
      .filter((e) => (target === 'hide' ? !e.hidden : e.hidden))
      .map((e) => ({ relativePath: e.relativePath, hidden: target === 'hide' }));
    if (changes.length === 0) return;
    try {
      const result = await window.mister.setBulkArcadeMraVisibility(changes);
      const summary = summarizeBulkResult({
        action: target === 'hide' ? 'Hid' : 'Restored',
        itemNoun: 'ROM',
        succeeded: result.succeeded,
        failed: result.failed,
        failedNames: result.failed.map((f) => f.filename),
      });
      const surface =
        summary.kind === 'success'
          ? toast.success
          : summary.kind === 'partial'
            ? toast.warning
            : toast.error;
      surface(summary.title, { description: summary.description });
      await refresh(true);
    } catch (err) {
      toast.error(
        target === 'hide' ? 'Hid failed' : 'Restored failed',
        {
          description: err instanceof Error ? err.message : 'Unexpected error.',
        },
      );
    }
  };

  /**
   * Toggle the persisted auto-hide preference. The main-process
   * call also applies the rule diff (hides every missing-ROM mra
   * on OFF→ON, restores every auto-hidden mra on ON→OFF), so we
   * refresh the entry list + playability after a successful flip.
   *
   * The checkbox flips optimistically so the user sees the change
   * land immediately even though the bulk SSH rename takes ~3-5s
   * for a typical 100-mra diff. On failure we revert and surface
   * the toast.
   */
  const onToggleAutoHide = async (next: boolean): Promise<void> => {
    if (!canMutate || autoHideEnabled === null) return;
    const prev = autoHideEnabled;
    setAutoHidePending(true);
    setAutoHideEnabled(next);
    try {
      await window.mister.setArcadeAutoHideEnabled(next);
      await refresh(true);
    } catch (err) {
      setAutoHideEnabled(prev);
      toast.error(
        `Could not ${next ? 'enable' : 'disable'} auto-hide`,
        {
          description: err instanceof Error ? err.message : 'Unexpected error.',
        },
      );
    } finally {
      setAutoHidePending(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="flex flex-col gap-3 border-b border-subtle bg-chrome px-4 py-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-heading text-fg">Arcade</h2>
          <span className="font-mono text-body-sm text-fg-muted tabular">
            {visibleCount}
            {hiddenCount > 0 ? (
              <span className="text-fg-disabled"> ({hiddenCount})</span>
            ) : null}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void runBulk('hide')}
            disabled={!canMutate || mraRows.every((r) => r.hidden)}
            title={
              canMutate
                ? 'Hide every visible .mra so it disappears from the MiSTer arcade menu.'
                : 'Reconnect to make changes.'
            }
          >
            <EyeOff strokeWidth={1.5} />
            Hide all
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void runBulk('show')}
            disabled={!canMutate || mraRows.every((r) => !r.hidden)}
            title={
              canMutate
                ? 'Restore every hidden .mra back into the MiSTer arcade menu.'
                : 'Reconnect to make changes.'
            }
          >
            <Eye strokeWidth={1.5} />
            Show all
          </Button>
          <label
            className={cn(
              'ml-auto flex items-center gap-2 text-body-sm text-fg-body',
              (!canMutate || autoHidePending || autoHideEnabled === null) &&
                'opacity-60',
            )}
            title={
              canMutate
                ? 'When on, .mras whose ROM zips are missing from games/mame/ + games/hbmame/ are dot-prefixed so the MiSTer arcade menu only shows what you can actually play.'
                : 'Reconnect to change.'
            }
          >
            <input
              type="checkbox"
              className="accent-accent"
              checked={autoHideEnabled ?? true}
              disabled={
                !canMutate || autoHidePending || autoHideEnabled === null
              }
              onChange={(e) => void onToggleAutoHide(e.target.checked)}
            />
            Auto-hide missing ROMs
            {autoHidePending ? (
              <Loader2
                className="ml-1 size-3.5 animate-spin text-fg-muted"
                strokeWidth={1.5}
              />
            ) : null}
          </label>
          <label className="flex items-center gap-2 text-body-sm text-fg-body">
            <input
              type="checkbox"
              className="accent-accent"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Show hidden
          </label>
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {loading && entries === null ? (
          <div className="flex h-32 items-center justify-center text-body-sm text-fg-muted">
            <Loader2 className="mr-2 size-4 animate-spin" strokeWidth={1.5} />
            Loading arcade entries…
          </div>
        ) : error !== null ? (
          <div className="p-4 text-body-sm text-destructive">
            {error}
          </div>
        ) : presentable.length === 0 ? (
          <div className="p-4 text-body-sm text-fg-muted">
            {entries === null || mraRows.length === 0
              ? 'No .mra files found in _Arcade/.'
              : 'All .mra files are hidden — toggle "Show hidden" to manage them.'}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-24 text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {presentable.map((entry) => {
                const isPending = pendingPaths.has(entry.relativePath);
                const visiblePath = arcadeMraVisiblePath(entry.relativePath);
                const isAutoHidden =
                  entry.hidden && autoHiddenSet.has(visiblePath);
                const classification =
                  playabilityByPath.get(entry.relativePath) ?? null;
                const isMissing = classification === 'missing';
                const tooltip = entry.hidden
                  ? isAutoHidden
                    ? `Show ${entry.displayName} (auto-hidden because ROMs are missing)`
                    : `Show ${entry.displayName} (you hid this)`
                  : `Hide ${entry.displayName}`;
                return (
                  <TableRow key={entry.relativePath}>
                    <TableCell
                      className={cn(
                        'max-w-0 truncate',
                        entry.hidden && 'opacity-50 italic',
                      )}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="truncate text-body-sm text-fg"
                            title={entry.displayName}
                          >
                            {stripMraExtension(entry.displayName)}
                          </span>
                          {isMissing ? (
                            <span
                              className="inline-block shrink-0 rounded border border-destructive/40 bg-destructive/15 px-1 text-caption uppercase tracking-[0.06em] text-destructive"
                              title="At least one ROM zip referenced by this .mra is not present in games/mame/ or games/hbmame/."
                            >
                              Missing ROMs
                            </span>
                          ) : null}
                        </span>
                        {entry.relativePath !== entry.displayName ? (
                          <span
                            className="truncate text-caption text-fg-muted"
                            title={entry.relativePath}
                          >
                            {entry.relativePath}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void onToggleSingle(entry)}
                        disabled={!canMutate || isPending}
                        title={canMutate ? tooltip : 'Reconnect to make changes.'}
                        aria-label={tooltip}
                      >
                        {isPending ? (
                          <Loader2
                            className="size-4 animate-spin"
                            strokeWidth={1.5}
                          />
                        ) : entry.hidden ? (
                          <EyeOff strokeWidth={1.5} />
                        ) : (
                          <Eye strokeWidth={1.5} />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function wireToEntries(
  wire: readonly ArcadeMraEntryWire[],
): readonly ArcadeMraEntry[] {
  // The wire shape is structurally identical to ArcadeMraEntry —
  // the cast is safe and avoids a per-row clone for ~thousands of
  // entries.
  return wire as readonly ArcadeMraEntry[];
}

function stripMraExtension(name: string): string {
  return name.toLowerCase().endsWith('.mra')
    ? name.slice(0, -'.mra'.length)
    : name;
}
