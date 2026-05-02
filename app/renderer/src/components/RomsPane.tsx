import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import type { Core, Rom } from '@shared/types';

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
import { formatBytes } from '@app/renderer/src/lib/format';
import type { VisibilityChange } from '@app/renderer/src/lib/optimistic';

interface RomsPaneProps {
  readonly core: Core;
}

export function RomsPane({ core }: RomsPaneProps): JSX.Element {
  const { romsByCore, romsLoading, ensureRoms, setRomVisibility, setBulkRomVisibility } =
    useCores();
  const roms = romsByCore[core.id];
  const loading = romsLoading[core.id] ?? false;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  // Reset selection when the visible core changes.
  useEffect(() => {
    setSelected(new Set());
  }, [core.id]);

  // Lazy-fetch ROMs for the active core.
  useEffect(() => {
    void ensureRoms(core.id);
  }, [core.id, ensureRoms]);

  const visibleSelectedCount = useMemo(() => {
    if (!roms) return 0;
    return roms.filter((r) => selected.has(r.filename) && !r.hidden).length;
  }, [roms, selected]);

  const hiddenSelectedCount = useMemo(() => {
    if (!roms) return 0;
    return roms.filter((r) => selected.has(r.filename) && r.hidden).length;
  }, [roms, selected]);

  const onToggleSelect = (filename: string, checked: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(filename);
      else next.delete(filename);
      return next;
    });
  };

  const onToggleAll = (checked: boolean): void => {
    if (!roms) return;
    setSelected(checked ? new Set(roms.map((r) => r.filename)) : new Set());
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

  const runBulk = async (changes: readonly VisibilityChange[], label: string): Promise<void> => {
    if (changes.length === 0) return;
    try {
      await setBulkRomVisibility(core.id, changes);
    } catch (err) {
      toast.error(label, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onHideAll = (): void => {
    if (!roms) return;
    const changes: VisibilityChange[] = roms
      .filter((r) => !r.hidden)
      .map((r) => ({ filename: r.filename, hidden: true }));
    void runBulk(changes, 'Bulk hide failed');
  };

  const onShowAll = (): void => {
    if (!roms) return;
    const changes: VisibilityChange[] = roms
      .filter((r) => r.hidden)
      .map((r) => ({ filename: r.filename, hidden: false }));
    void runBulk(changes, 'Bulk show failed');
  };

  const onHideSelected = (): void => {
    if (!roms) return;
    const changes: VisibilityChange[] = roms
      .filter((r) => selected.has(r.filename) && !r.hidden)
      .map((r) => ({ filename: r.filename, hidden: true }));
    void runBulk(changes, 'Hide selected failed');
    setSelected(new Set());
  };

  const onShowSelected = (): void => {
    if (!roms) return;
    const changes: VisibilityChange[] = roms
      .filter((r) => selected.has(r.filename) && r.hidden)
      .map((r) => ({ filename: r.filename, hidden: false }));
    void runBulk(changes, 'Show selected failed');
    setSelected(new Set());
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{core.name}</h2>
            <p className="text-xs text-muted-foreground">
              {core.romCount} ROMs · {core.hiddenCount} hidden
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onHideAll} disabled={!roms || roms.every((r) => r.hidden)}>
              Hide all
            </Button>
            <Button variant="outline" size="sm" onClick={onShowAll} disabled={!roms || roms.every((r) => !r.hidden)}>
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
      </header>

      <div className="flex-1 overflow-auto">
        {loading && !roms ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : !roms || roms.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">No ROMs in this core.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={selected.size === roms.length && roms.length > 0}
                    onChange={(e) => onToggleAll(e.target.checked)}
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="w-24 text-right">Size</TableHead>
                <TableHead className="w-24 text-right">Visibility</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roms.map((rom) => {
                const isSelected = selected.has(rom.filename);
                return (
                  <TableRow key={rom.filename} data-state={isSelected ? 'selected' : undefined}>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`Select ${rom.displayName}`}
                        checked={isSelected}
                        onChange={(e) => onToggleSelect(rom.filename, e.target.checked)}
                      />
                    </TableCell>
                    <TableCell
                      className={cn(
                        'truncate font-medium',
                        rom.hidden && 'italic text-muted-foreground',
                      )}
                    >
                      {rom.displayName}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatBytes(rom.sizeBytes)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void onSingleToggle(rom)}
                      >
                        {rom.hidden ? (
                          <>
                            <Eye />
                            Show
                          </>
                        ) : (
                          <>
                            <EyeOff />
                            Hide
                          </>
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
