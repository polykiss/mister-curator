import {
  ArrowLeft,
  Cog,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  MoreHorizontal,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { isAutoDetectedSystemFile, isSystemFile } from '@shared/system-files';
import type { CoreEntry, Rom } from '@shared/types';

/**
 * Narrows a `Rom.kind` (file / folder-atomic / folder-container) down
 * to the simpler `'file' | 'folder'` shape that `isSystemFile` and
 * `isAutoDetectedSystemFile` expect. The atomic/container distinction
 * doesn't matter for system-file detection — both are folders.
 */
function romKindForSystemCheck(kind: Rom['kind']): 'file' | 'folder' {
  return kind === 'file' ? 'file' : 'folder';
}

import {
  RomRowMenu,
  type RomRowMenuItem,
} from '@app/renderer/src/components/RomRowMenu';
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
import { romsKey, useCores } from '@app/renderer/src/contexts/CoresContext';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import {
  computeBackRow,
  computeBreadcrumb,
  subPathAtDepth,
} from '@app/renderer/src/lib/breadcrumb';
import { cn } from '@app/renderer/src/lib/cn';
import { formatBytes, summarizeBulkResult } from '@app/renderer/src/lib/format';
import type { VisibilityChange } from '@app/renderer/src/lib/optimistic';
import { usePersistedBool } from '@app/renderer/src/lib/use-persisted-bool';

/**
 * Tooltip for buttons disabled because the SSH session is in a
 * lost-connection / reconnecting state. Mirrors the spec wording.
 */
const DISCONNECTED_TOOLTIP = 'Reconnect to make changes.';

interface RomsPaneProps {
  readonly core: CoreEntry;
}

export function RomsPane({ core }: RomsPaneProps): JSX.Element {
  const {
    romsByCore,
    romsLoading,
    ensureRoms,
    refetchRoms,
    setRomVisibility,
    setBulkRomVisibility,
    systemFilesMarks,
    isUserMarked,
    addSystemFileMark,
    removeSystemFileMark,
    setSystemFileMarks,
    setFolderClassification,
  } = useCores();
  const { status } = useConnection();
  // Mid-session disconnect / pre-reconnect state — every mutating
  // button gates on this. Reads (browse, drill, filter) stay enabled
  // so the user can still inspect the cached state.
  const canMutate = status === 'connected';
  // Drilled-in path inside the core. Empty string means top-level.
  // Slash-joined for nested folders (`'1 World A-Z'`,
  // `'parent/child'`). Used for every ROM-level operation; the cores
  // pane and counts always reflect the top-level view.
  const [subPath, setSubPath] = useState<string>('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // Round 3 default: show hidden ROMs by default — they're typically
  // the user's recent work and they want to see what they did. The
  // user's last choice persists across sessions via localStorage.
  const [showHidden, setShowHidden] = usePersistedBool(
    'mistercurator.showHiddenRoms',
    true,
  );
  // System files stay off by default — they're noise (BIOSes, palettes,
  // configs) and the system-files-marks UI is the place to manage them.
  const [showSystem, setShowSystem] = usePersistedBool(
    'mistercurator.showSystemFiles',
    false,
  );
  const [menuFor, setMenuFor] = useState<{
    readonly rom: Rom;
    readonly x: number;
    readonly y: number;
  } | null>(null);

  // Reset drill state SYNCHRONOUSLY when the visible core changes so
  // the `ensureRoms` effect below never sees a stale subPath against a
  // new core. Without this, switching from `NEOGEO/1 World A-Z` to
  // Saturn would fire `listRoms('Saturn', '1 World A-Z')` once before
  // the [core.id] reset effect committed — that call fails with
  // "Unknown core: Saturn" in the main-process log.
  // Pattern reference: https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [trackedCoreId, setTrackedCoreId] = useState(core.id);
  if (trackedCoreId !== core.id) {
    setTrackedCoreId(core.id);
    setSubPath('');
    setSelected(new Set());
  }

  const cacheKey = romsKey(core.id, subPath);
  const roms = romsByCore[cacheKey];
  const loading = romsLoading[cacheKey] ?? false;

  // Reset selection on every drill in/out so a ghost selection from
  // the previous level never leaks into a different list.
  useEffect(() => {
    setSelected(new Set());
  }, [subPath]);

  // Lazy-fetch ROMs at the current (core, subPath) — including after
  // a drill into a container. The render-time reset above guarantees
  // that when this effect fires for a new core, subPath is already ''.
  useEffect(() => {
    void ensureRoms(core.id, subPath);
  }, [core.id, subPath, ensureRoms]);

  // System-file classification is keyed on (filename, kind). Cache for
  // the current rom list so the renderer doesn't re-classify on every
  // re-render. Uses the combined check — auto-detector OR user-marks.
  const systemFlags = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const r of roms ?? []) {
      map.set(
        r.filename,
        isSystemFile(
          { filename: r.filename, kind: romKindForSystemCheck(r.kind) },
          { marks: systemFilesMarks, coreId: core.id },
        ),
      );
    }
    return map;
  }, [roms, systemFilesMarks, core.id]);

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

  // The "Mark selected as system" / "Unmark selected" toolbar buttons
  // operate on whatever the user has selected:
  //   - markable: not currently flagged as system at all (so we won't
  //     touch auto-detected files; they're system already and can't be
  //     unmarked anyway) AND not yet in the marks list
  //   - unmarkable: currently in the marks list (auto-detected files
  //     are excluded — they're heuristic, not stored)
  const markableSelected = useMemo(() => {
    if (!roms) return [];
    return roms.filter((r) => {
      if (!selected.has(r.filename)) return false;
      const auto = isAutoDetectedSystemFile({
        filename: r.filename,
        kind: romKindForSystemCheck(r.kind),
      });
      if (auto) return false;
      return !isUserMarked(core.id, r.filename);
    });
  }, [roms, selected, core.id, isUserMarked]);

  const unmarkableSelected = useMemo(() => {
    if (!roms) return [];
    return roms.filter(
      (r) => selected.has(r.filename) && isUserMarked(core.id, r.filename),
    );
  }, [roms, selected, core.id, isUserMarked]);

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
      await setRomVisibility(core.id, rom.filename, !rom.hidden, subPath);
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
      result = await setBulkRomVisibility(core.id, changes, subPath);
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

  const onMarkAsSystem = async (rom: Rom): Promise<void> => {
    try {
      await addSystemFileMark(core.id, rom.filename);
      // The CoresContext refetches the top-level ROM list; if we're
      // drilled in we need to also refetch THIS level so the row picks
      // up its new system status.
      if (subPath !== '') await refetchRoms(core.id, subPath);
      toast.success(`Marked ${rom.displayName} as system file`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await removeSystemFileMark(core.id, rom.filename);
              } catch {
                /* swallow */
              }
            })();
          },
        },
      });
    } catch (err) {
      toast.error(`Could not mark ${rom.displayName}`, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onMarkSelectedAsSystem = async (): Promise<void> => {
    const targets = markableSelected;
    if (targets.length === 0) return;
    const changes = targets.map((r) => ({ filename: r.filename, marked: true }));
    try {
      await setSystemFileMarks(core.id, changes);
      if (subPath !== '') await refetchRoms(core.id, subPath);
      toast.success(
        `Marked ${String(targets.length)} file${targets.length === 1 ? '' : 's'} as system`,
        {
          action: {
            label: 'Undo',
            onClick: () => {
              void (async () => {
                try {
                  await setSystemFileMarks(
                    core.id,
                    targets.map((r) => ({ filename: r.filename, marked: false })),
                  );
                } catch {
                  /* swallow */
                }
              })();
            },
          },
        },
      );
      setSelected(new Set());
    } catch (err) {
      toast.error('Mark as system failed', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onUnmarkSelected = async (): Promise<void> => {
    const targets = unmarkableSelected;
    if (targets.length === 0) return;
    const changes = targets.map((r) => ({ filename: r.filename, marked: false }));
    try {
      await setSystemFileMarks(core.id, changes);
      if (subPath !== '') await refetchRoms(core.id, subPath);
      toast.success(
        `Unmarked ${String(targets.length)} file${targets.length === 1 ? '' : 's'}`,
        {
          action: {
            label: 'Undo',
            onClick: () => {
              void (async () => {
                try {
                  await setSystemFileMarks(
                    core.id,
                    targets.map((r) => ({ filename: r.filename, marked: true })),
                  );
                } catch {
                  /* swallow */
                }
              })();
            },
          },
        },
      );
      setSelected(new Set());
    } catch (err) {
      toast.error('Unmark failed', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onUnmarkSystem = async (rom: Rom): Promise<void> => {
    try {
      await removeSystemFileMark(core.id, rom.filename);
      if (subPath !== '') await refetchRoms(core.id, subPath);
      toast.success(`Unmarked ${rom.displayName}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await addSystemFileMark(core.id, rom.filename);
              } catch {
                /* swallow */
              }
            })();
          },
        },
      });
    } catch (err) {
      toast.error(`Could not unmark ${rom.displayName}`, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onSetClassification = async (
    rom: Rom,
    classification: 'container' | 'atomic' | null,
  ): Promise<void> => {
    // The override key is the visible (un-dotted) relative path —
    // matches how `listRoms` builds the lookup so a hide/unhide later
    // doesn't break the override.
    const visibleRelPath =
      (subPath === '' ? '' : `${subPath}/`) +
      (rom.hidden ? rom.filename.slice(1) : rom.filename);
    try {
      await setFolderClassification(core.id, visibleRelPath, classification, {
        coreId: core.id,
        subPath,
      });
      toast.success(
        classification === null
          ? `Reset classification for ${rom.displayName}`
          : `Treating ${rom.displayName} as ${classification}`,
      );
    } catch (err) {
      toast.error('Could not update folder classification', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  function buildMenuItems(rom: Rom): readonly RomRowMenuItem[] {
    const items: RomRowMenuItem[] = [];

    // Folder rows get classification overrides — the user can pin a
    // specific folder to container/atomic against the auto-detector.
    // Classification overrides write to an on-MiSTer marks file, so
    // they're gated on a live connection just like system-file marks.
    if (rom.kind !== 'file') {
      const isContainer = rom.kind === 'folder-container';
      items.push({
        label: isContainer ? 'Treat as atomic (one game)' : 'Treat as container (drill in)',
        onSelect: () =>
          void onSetClassification(rom, isContainer ? 'atomic' : 'container'),
        disabled: !canMutate,
        title: canMutate
          ? 'Override the auto-detector for this folder. Persists in the on-MiSTer marks file.'
          : DISCONNECTED_TOOLTIP,
      });
      items.push({
        label: 'Reset to auto-detected',
        onSelect: () => void onSetClassification(rom, null),
        disabled: !canMutate,
        title: canMutate
          ? 'Drop the user override and let the heuristic classify this folder.'
          : DISCONNECTED_TOOLTIP,
      });
    }

    // System-file mark items — auto-detected files cannot be unmarked
    // (the heuristic decides every connection). The disabled item
    // surfaces this without hiding the option.
    const auto = isAutoDetectedSystemFile({
      filename: rom.filename,
      kind: romKindForSystemCheck(rom.kind),
    });
    const marked = isUserMarked(core.id, rom.filename);
    if (auto) {
      items.push({
        label: 'Auto-detected — cannot unmark',
        onSelect: () => undefined,
        disabled: true,
        title:
          'This file matches a built-in system-file pattern (BIOS, config, palette).',
      });
    } else if (marked) {
      items.push({
        label: 'Unmark as system file',
        onSelect: () => void onUnmarkSystem(rom),
        disabled: !canMutate,
        title: canMutate
          ? 'Treat this file as a regular ROM again. Removes it from the system-files list.'
          : DISCONNECTED_TOOLTIP,
      });
    } else {
      items.push({
        label: 'Mark as system file',
        onSelect: () => void onMarkAsSystem(rom),
        disabled: !canMutate,
        title: canMutate
          ? 'Hide this file from the ROM list and exclude it from bulk operations.'
          : DISCONNECTED_TOOLTIP,
      });
    }

    return items;
  }

  /**
   * Click handler for a row's main button. For container folders,
   * this drills into the folder; for atomic folders and files, the
   * row's normal selection behavior takes over (handled separately).
   */
  function onRowActivate(rom: Rom): void {
    if (rom.kind === 'folder-container' && !rom.hidden) {
      const visibleBase = rom.hidden ? rom.filename.slice(1) : rom.filename;
      const next = subPath === '' ? visibleBase : `${subPath}/${visibleBase}`;
      setSubPath(next);
    }
  }

  function navigateToDepth(targetDepth: number): void {
    setSubPath(subPathAtDepth(subPath, targetDepth));
  }

  const breadcrumb = computeBreadcrumb(core.name, subPath);
  const backRow = computeBackRow(core.name, subPath);

  return (
    <div className="flex h-full flex-col">
      {/* Header is a vertical stack — breadcrumb on its own row so a
          long path can scroll horizontally without crowding the
          toolbar; subtitle on its own row; action buttons on their
          own row (wrapping only when the window is unusually narrow);
          filter checkboxes on the bottom row. Each row owns its full
          horizontal width. */}
      <header className="space-y-2 border-b p-4">
        <nav
          aria-label="Folder breadcrumb"
          // Owns the full width of the header. Allows horizontal
          // scrolling when the path gets too long instead of clipping
          // or wrapping to two lines.
          className="flex items-center gap-1 overflow-x-auto whitespace-nowrap text-lg"
        >
          {breadcrumb.map((seg, i) => (
            <span
              key={`${String(seg.depth)}-${seg.label}`}
              className="flex shrink-0 items-center gap-1"
            >
              {i > 0 ? (
                <span
                  aria-hidden
                  className="shrink-0 select-none text-base text-muted-foreground/50"
                >
                  ›
                </span>
              ) : null}
              {seg.current ? (
                <span
                  aria-current="page"
                  className="font-semibold text-foreground"
                  title={seg.label}
                >
                  {seg.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => navigateToDepth(seg.depth)}
                  className="rounded -mx-1 px-1 text-muted-foreground hover:text-foreground focus-visible:text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
                  title={`Go to ${seg.label}`}
                >
                  {seg.label}
                </button>
              )}
            </span>
          ))}
        </nav>
        <p className="text-xs text-muted-foreground">
          {visibleNonSystem} ROMs · {hiddenNonSystem} hidden
          {systemCount > 0 ? <> · {systemCount} system</> : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onHideAll}
            disabled={!canMutate || candidates.every((r) => r.hidden)}
            title={canMutate ? undefined : DISCONNECTED_TOOLTIP}
          >
            Hide all
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onShowAll}
            disabled={!canMutate || candidates.every((r) => !r.hidden)}
            title={canMutate ? undefined : DISCONNECTED_TOOLTIP}
          >
            Unhide all
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onHideSelected}
            disabled={!canMutate || visibleSelectedCount === 0}
            title={canMutate ? undefined : DISCONNECTED_TOOLTIP}
          >
            Hide selected ({visibleSelectedCount})
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onShowSelected}
            disabled={!canMutate || hiddenSelectedCount === 0}
            title={canMutate ? undefined : DISCONNECTED_TOOLTIP}
          >
            Unhide selected ({hiddenSelectedCount})
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onMarkSelectedAsSystem()}
            disabled={!canMutate || markableSelected.length === 0}
            title={
              canMutate
                ? "Treat the selected files as system files (BIOS, palette, config). Hidden by default; visible when 'Show system files' is on."
                : DISCONNECTED_TOOLTIP
            }
          >
            Mark as system ({markableSelected.length})
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onUnmarkSelected()}
            disabled={!canMutate || unmarkableSelected.length === 0}
            title={
              canMutate
                ? 'Remove the user-system mark from the selected files. Auto-detected system files are not affected.'
                : DISCONNECTED_TOOLTIP
            }
          >
            Unmark system ({unmarkableSelected.length})
          </Button>
        </div>
        <div className="flex flex-wrap gap-4 text-xs">
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
                <TableHead className="w-10" aria-label="Actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {backRow ? (
                <TableRow
                  className="bg-muted/40 hover:bg-muted"
                  onClick={() => setSubPath(backRow.targetSubPath)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSubPath(backRow.targetSubPath);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Back to ${backRow.parentLabel}`}
                  title={`Back to ${backRow.parentLabel}`}
                >
                  {/* Spans every column so this row reads visually
                      distinct from a regular ROM row — no checkbox, no
                      size, no visibility toggle. The total column count
                      matches `<TableHeader>` (5: select / name / size /
                      visibility / actions). */}
                  <TableCell colSpan={5} className="cursor-pointer py-1.5">
                    <span className="inline-flex items-center gap-2 italic text-muted-foreground">
                      <ArrowLeft
                        className="h-3.5 w-3.5 shrink-0"
                        aria-hidden
                      />
                      <span className="truncate">
                        .. (Back to {backRow.parentLabel})
                      </span>
                    </span>
                  </TableCell>
                </TableRow>
              ) : null}
              {presentableRoms.map((rom) => {
                const isSelected = selected.has(rom.filename);
                const isSystem = systemFlags.get(rom.filename) === true;
                return (
                  <TableRow
                    key={rom.filename}
                    data-state={isSelected ? 'selected' : undefined}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenuFor({ rom, x: e.clientX, y: e.clientY });
                    }}
                    className={cn(
                      // Hidden ROMs: half-opacity row + solid muted bg +
                      // italic + a destructive HIDDEN badge left of the
                      // name. No strikethrough — same treatment as the
                      // cores list so panes feel consistent.
                      rom.hidden && 'bg-muted italic text-muted-foreground opacity-50',
                    )}
                  >
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
                        rom.kind === 'folder-container' &&
                          !rom.hidden &&
                          'cursor-pointer',
                      )}
                      onDoubleClick={() => onRowActivate(rom)}
                      onClick={(e) => {
                        // Single-click drilling on container folders
                        // (the spec says "click to drill in"). Don't
                        // intercept clicks on the action buttons in
                        // adjacent cells — those bubble up via a
                        // different path.
                        if (rom.kind === 'folder-container' && !rom.hidden) {
                          e.preventDefault();
                          onRowActivate(rom);
                        }
                      }}
                      title={
                        rom.kind === 'folder-container' && !rom.hidden
                          ? `Open ${rom.displayName}`
                          : undefined
                      }
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {/* Badge order is fixed: SYSTEM left of HIDDEN
                            left of name. Mirrors the cores list, where
                            HIDDEN sits to the left of the core name. */}
                        {isSystem ? (
                          <span
                            className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide not-italic text-muted-foreground"
                            title="System file (BIOS, config, palette). MiSTerCurator never bulk-toggles these."
                          >
                            System
                          </span>
                        ) : null}
                        {rom.hidden ? (
                          <span
                            className="shrink-0 rounded bg-destructive px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide not-italic text-destructive-foreground"
                            title="This ROM is hidden from the MiSTer menu."
                          >
                            Hidden
                          </span>
                        ) : null}
                        {isSystem ? (
                          <Cog
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-label="system file"
                          />
                        ) : rom.kind === 'folder-container' ? (
                          // Container folders are drillable — chevron
                          // hint mirrors what clicking the row does.
                          <FolderOpen
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-label="container folder"
                          />
                        ) : rom.kind === 'folder-atomic' ? (
                          <Folder
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-label="folder ROM"
                          />
                        ) : null}
                        <span className="truncate">{rom.displayName}</span>
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
                        // Round 3: filled prominence. Hide gets a slate
                        // fill (visible but not aggressive); Show gets
                        // the primary fill (emphatic positive). Same
                        // dimensions both ways so layout stays steady
                        // when a row flips state.
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => void onSingleToggle(rom)}
                          disabled={!canMutate}
                          className={cn(
                            'min-w-[5.5rem] not-italic',
                            rom.hidden
                              ? // Show: primary fill
                                undefined
                              : // Hide: slate fill (works in both themes)
                                'bg-slate-700 text-slate-50 hover:bg-slate-600 dark:bg-slate-600 dark:hover:bg-slate-500',
                          )}
                          title={
                            canMutate
                              ? rom.hidden
                                ? `Show ${rom.displayName}`
                                : `Hide ${rom.displayName}`
                              : DISCONNECTED_TOOLTIP
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
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="More actions"
                        aria-label={`More actions for ${rom.displayName}`}
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setMenuFor({ rom, x: r.left, y: r.bottom });
                        }}
                      >
                        <MoreHorizontal />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      {menuFor ? (
        <RomRowMenu
          x={menuFor.x}
          y={menuFor.y}
          items={buildMenuItems(menuFor.rom)}
          onClose={() => setMenuFor(null)}
        />
      ) : null}
    </div>
  );
}
