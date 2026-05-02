import { Cog, Eye, EyeOff, Folder } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { isSystemFile } from '@shared/system-files';
import type { CoreEntry, Rom } from '@shared/types';

import { Button } from '@app/renderer/src/components/ui/button';
import { Skeleton } from '@app/renderer/src/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@app/renderer/src/components/ui/table';
import { useCores } from '@app/renderer/src/contexts/CoresContext';
import { cn } from '@app/renderer/src/lib/cn';
import { formatBytes, summarizeBulkResult } from '@app/renderer/src/lib/format';
import type { VisibilityChange } from '@app/renderer/src/lib/optimistic';

interface RomsPaneProps {
  readonly core: CoreEntry;
}

export function RomsPane({ core }: RomsPaneProps): JSX.Element {
  const { romsByCore, romsLoading, ensureRoms, setRomVisibility, setBulkRomVisibility } =
    useCores();
  const roms = romsByCore[core.id];
  const loading = romsLoading[core.id] ?? false;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [showSystem, setShowSystem] = useState(false);

  // Reset selection when the visible core changes.
  useEffect(() => {
    setSelected(new Set());
  }, [core.id]);

  // Lazy-fetch ROMs for the active core.
  useEffect(() => {
    void ensureRoms(core.id);
  }, [core.id, ensureRoms]);

  // System-file classification is keyed on (filename, kind). Cache for
  // the current rom list so the renderer doesn't re-classify on every
  // re-render.
  const systemFlags = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const r of roms ?? []) {
      map.set(r.filename, isSystemFile({ filename: r.filename, kind: r.kind }));
    }
    return map;
  }, [roms]);

  // The list the user actually sees — hidden + system filters apply
  // independently. Counts in the header reflect this filtered view so
  // "47 ROMs" doesn't include the 12 NEOGEO BIOS files when
  // `showSystem` is off.
  const presentableRoms = useMemo(() => {
    if (!roms) return null;
    return roms.filter((r) => {
      if (!showHidden && r.hidden) return false;
      if (!showSystem && systemFlags.get(r.filename) === true) return false;
      return true;
    });
  }, [roms, showHidden, showSystem, systemFlags]);

  // Counts shown in the header — non-system ROMs only.
  const visibleNonSystem = useMemo(() => {
    if (!roms) return 0;
    return roms.filter((r) => !r.hidden && systemFlags.get(r.filename) !== true).length;
  }, [roms, systemFlags]);
  const hiddenNonSystem = useMemo(() => {
    if (!roms) return 0;
    return roms.filter((r) => r.hidden && systemFlags.get(r.filename) !== true).length;
  }, [roms, systemFlags]);
  const systemCount = useMemo(() => {
    if (!roms) return 0;
    return roms.filter((r) => systemFlags.get(r.filename) === true).length;
  }, [roms, systemFlags]);

  const visibleSelectedCount = useMemo(() => {
    if (!presentableRoms) return 0;
    return presentableRoms.filter((r) => selected.has(r.filename) && !r.hidden).length;
  }, [presentableRoms, selected]);

  const hiddenSelectedCount = useMemo(() => {
    if (!presentableRoms) return 0;
    return presentableRoms.filter((r) => selected.has(r.filename) && r.hidden).length;
  }, [presentableRoms, selected]);

  const onToggleSelect = (filename: string, checked: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(filename);
      else next.delete(filename);
      return next;
    });
  };

  const onToggleAll = (checked: boolean): void => {
    if (!presentableRoms) return;
    setSelected(checked ? new Set(presentableRoms.map((r) => r.filename)) : new Set());
  };

  const onSingleToggle = async (rom: Rom): Promise<void> => {
    try {
      await setRomVisibility(core.id, rom.filename, !rom.hidden);
    } catch (err) {
      toast.error(`Could not ${rom.hidden ? 'show' : 'hide'} ${rom.displayName}`, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const runBulk = async (
    changes: readonly VisibilityChange[],
    action: 'Hid' | 'Restored',
  ): Promise<void> => {
    if (changes.length === 0) return;
    let result;
    try {
      result = await setBulkRomVisibility(core.id, changes);
    } catch (err) {
      toast.error(`${action} failed`, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
      return;
    }
    const summary = summarizeBulkResult({
      action,
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
  };

  // "Hide all" / "Show all" / selected actions only target NON-system
  // ROMs. We never invite the user to hide a BIOS via a bulk op.
  const candidates = useMemo(() => roms?.filter((r) => systemFlags.get(r.filename) !== true) ?? [], [roms, systemFlags]);

  const onHideAll = (): void => {
    const changes: VisibilityChange[] = candidates
      .filter((r) => !r.hidden)
      .map((r) => ({ filename: r.filename, hidden: true }));
    void runBulk(changes, 'Hid');
  };

  const onShowAll = (): void => {
    const changes: VisibilityChange[] = candidates
      .filter((r) => r.hidden)
      .map((r) => ({ filename: r.filename, hidden: false }));
    void runBulk(changes, 'Restored');
  };

  const onHideSelected = (): void => {
    if (!presentableRoms) return;
    const changes: VisibilityChange[] = presentableRoms
      .filter(
        (r) =>
          selected.has(r.filename) &&
          !r.hidden &&
          systemFlags.get(r.filename) !== true,
      )
      .map((r) => ({ filename: r.filename, hidden: true }));
    void runBulk(changes, 'Hid');
    setSelected(new Set());
  };

  const onShowSelected = (): void => {
    if (!presentableRoms) return;
    const changes: VisibilityChange[] = presentableRoms
      .filter(
        (r) =>
          selected.has(r.filename) &&
          r.hidden &&
          systemFlags.get(r.filename) !== true,
      )
      .map((r) => ({ filename: r.filename, hidden: false }));
    void runBulk(changes, 'Restored');
    setSelected(new Set());
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{core.name}</h2>
            <p className="text-xs text-muted-foreground">
              {visibleNonSystem} ROMs · {hiddenNonSystem} hidden
              {systemCount > 0 ? <> · {systemCount} system</> : null}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onHideAll}
              disabled={candidates.every((r) => r.hidden)}
            >
              Hide all
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onShowAll}
              disabled={candidates.every((r) => !r.hidden)}
            >
              Show all
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onHideSelected}
              disabled={visibleSelectedCount === 0}
            >
              Hide selected ({visibleSelectedCount})
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onShowSelected}
              disabled={hiddenSelectedCount === 0}
            >
              Show selected ({hiddenSelectedCount})
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-xs">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Show hidden
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={showSystem}
              onChange={(e) => setShowSystem(e.target.checked)}
            />
            Show system files
          </label>
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {loading && !roms ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : !presentableRoms || presentableRoms.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            {(roms ?? []).length === 0
              ? 'No ROMs in this core.'
              : 'Nothing to show. Toggle "Show hidden" or "Show system files" to see more.'}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={
                      presentableRoms.length > 0 &&
                      selected.size === presentableRoms.length
                    }
                    onChange={(e) => onToggleAll(e.target.checked)}
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="w-24 text-right">Size</TableHead>
                <TableHead className="w-24 text-right">Visibility</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {presentableRoms.map((rom) => {
                const isSelected = selected.has(rom.filename);
                const isSystem = systemFlags.get(rom.filename) === true;
                return (
                  <TableRow
                    key={rom.filename}
                    data-state={isSelected ? 'selected' : undefined}
                    className={cn(
                      // Hidden ROMs get an unmistakable visual treatment —
                      // muted background, low-contrast text, italics, line-
                      // through. Same as cores so the user sees consistency.
                      rom.hidden && 'bg-muted/50 text-muted-foreground',
                    )}
                  >
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`Select ${rom.displayName}`}
                        checked={isSelected}
                        onChange={(e) => onToggleSelect(rom.filename, e.target.checked)}
                        disabled={isSystem}
                      />
                    </TableCell>
                    <TableCell
                      className={cn(
                        'truncate font-medium',
                        rom.hidden && 'italic line-through',
                      )}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {isSystem ? (
                          <Cog
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-label="system file"
                          />
                        ) : rom.kind === 'folder' ? (
                          <Folder
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-label="folder ROM"
                          />
                        ) : null}
                        <span className="truncate">{rom.displayName}</span>
                        {isSystem ? (
                          <span
                            className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                            title="System file (BIOS, config, palette). MiSTerCurator never bulk-toggles these."
                          >
                            system
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatBytes(rom.sizeBytes)}
                    </TableCell>
                    <TableCell className="text-right">
                      {isSystem ? (
                        <span className="text-xs italic text-muted-foreground">
                          read-only
                        </span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void onSingleToggle(rom)}
                          title={
                            rom.hidden
                              ? `Show ${rom.displayName}`
                              : `Hide ${rom.displayName}`
                          }
                        >
                          {rom.hidden ? (
                            <>
                              <EyeOff />
                              Show
                            </>
                          ) : (
                            <>
                              <Eye />
                              Hide
                            </>
                          )}
                        </Button>
                      )}
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
