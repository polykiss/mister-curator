import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import type { ArcadeMraEntry } from '@shared/arcade-mra';
import type { ArcadeMraEntryWire } from '@shared/preload-api';

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
 * Phase 1.5 scope:
 *   • Flat listing of every `.mra` entry the parser returns
 *     (top-level + nested via slash-joined relativePath).
 *   • Drillable subfolders deferred — every nested .mra is just
 *     a row with the subfolder shown inline in the row's path.
 *     Users get one global view they can hide-all from.
 *   • No metadata columns (no year / genre / box art) — arcade
 *     metadata (Phase 2) parses .mra XML for that.
 *   • Hide/unhide via the new `setArcadeMraVisibility` /
 *     `setBulkArcadeMraVisibility` IPCs.
 *   • "Show hidden" toggle persists per-app like the ROM pane's.
 */
export function ArcadeMraPane(): JSX.Element {
  const { status } = useConnection();
  const canMutate = status === 'connected';

  const [entries, setEntries] = useState<readonly ArcadeMraEntry[] | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [showHidden, setShowHidden] = usePersistedBool(
    'mistercurator.showHiddenArcadeMras',
    true,
  );

  const refresh = useCallback(
    async (forceRefresh = false): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const wire = await window.mister.listArcadeMraEntries({ forceRefresh });
        setEntries(wireToEntries(wire));
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

  // Flat list of just `.mra` rows — subfolder kinds are
  // navigational structure for a hierarchical view we're not
  // building in Phase 1.5.
  const mraRows = useMemo(() => {
    if (entries === null) return [];
    return entries.filter((e) => e.kind === 'mra');
  }, [entries]);

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
          <label className="ml-auto flex items-center gap-2 text-body-sm text-fg-body">
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
                return (
                  <TableRow key={entry.relativePath}>
                    <TableCell
                      className={cn(
                        'max-w-0 truncate',
                        entry.hidden && 'opacity-50 italic',
                      )}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span
                          className="truncate text-body-sm text-fg"
                          title={entry.displayName}
                        >
                          {stripMraExtension(entry.displayName)}
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
                        title={
                          canMutate
                            ? entry.hidden
                              ? `Show ${entry.displayName}`
                              : `Hide ${entry.displayName}`
                            : 'Reconnect to make changes.'
                        }
                        aria-label={
                          entry.hidden
                            ? `Show ${entry.displayName}`
                            : `Hide ${entry.displayName}`
                        }
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
