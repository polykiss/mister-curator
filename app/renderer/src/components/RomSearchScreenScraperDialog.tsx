import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import type { RomMetadata } from '@shared/metadata-types';
import type { ScreenScraperGame } from '@shared/screenscraper-types';

import { Button } from '@app/renderer/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';
import { useBoxArt } from '@app/renderer/src/lib/use-box-art';

/**
 * PR-D2 (PR #29) — search-on-ScreenScraper modal.
 *
 * User-facing manual-search surface. Triggered from the row "..." menu
 * on every row but visually emphasized for source='none' rows where
 * the auto-pipeline missed.
 *
 * Flow:
 *   1. Modal opens with search input pre-filled from the filename
 *      stem (parens / brackets / extension stripped — the same
 *      `cleanForSearch` shape `filename-hint.ts` produces, mirrored
 *      inline since this is a renderer-only concern).
 *   2. User edits the search term + hits Search (or auto-search
 *      after a debounce — v0.1 uses explicit Search button to
 *      conserve the SS rate budget).
 *   3. IPC `searchScreenScraperByName(coreId, term)` returns
 *      ranked SS candidates.
 *   4. User clicks "Use this match" on a result.
 *   5. IPC `bindRomMetadataFromSearch(path, game)` writes the
 *      cache record with `source: 'manual-override'` and pinned
 *      `userOverride.jeuid`.
 *   6. Updated `RomMetadata` flows back through `onSaved` so the
 *      row re-renders immediately with new name + box art.
 *
 * Error states: empty results, network failure, rate-limited — all
 * surface inline within the dialog.
 */
export interface RomSearchScreenScraperDialogProps {
  readonly path: string;
  /** The on-disk filename — used for the search-input prefill. */
  readonly filename: string;
  /** Core display name shown in the dialog header for context. */
  readonly coreId: string;
  /** Core display label (`mame` → `Arcade`) for the header. */
  readonly coreLabel: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called with the updated record after successful bind. */
  readonly onSaved: (updated: RomMetadata) => void;
}

export function RomSearchScreenScraperDialog(
  props: RomSearchScreenScraperDialogProps,
): JSX.Element {
  const { path, filename, coreId, coreLabel, open, onOpenChange, onSaved } =
    props;

  const [searchTerm, setSearchTerm] = useState(() => filenameToSearchTerm(filename));
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<readonly ScreenScraperGame[] | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [bindingId, setBindingId] = useState<number | null>(null);
  // Track the latest search to ignore stale responses.
  const searchTokenRef = useRef(0);

  // Re-seed the search term when the dialog opens for a new row.
  useEffect(() => {
    if (open) {
      setSearchTerm(filenameToSearchTerm(filename));
      setResults(null);
      setErrorMessage(null);
    }
  }, [open, filename]);

  async function handleSearch(): Promise<void> {
    const term = searchTerm.trim();
    if (term === '') return;
    setSearching(true);
    setErrorMessage(null);
    const token = ++searchTokenRef.current;
    try {
      const candidates = await window.mister.searchScreenScraperByName(
        coreId,
        term,
      );
      if (token !== searchTokenRef.current) return; // stale
      setResults(candidates);
      if (candidates.length === 0) {
        setErrorMessage(
          'No matches found. Try different search terms — shorter or no region/version tags.',
        );
      }
    } catch (err) {
      if (token !== searchTokenRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(`Couldn't reach ScreenScraper: ${message}`);
    } finally {
      if (token === searchTokenRef.current) setSearching(false);
    }
  }

  async function handleUseMatch(game: ScreenScraperGame): Promise<void> {
    setBindingId(game.id);
    try {
      const updated = await window.mister.bindRomMetadataFromSearch(path, game);
      if (updated === null) {
        toast.error(
          'Couldn\'t bind — no metadata record for this row yet. Wait for the prefetch to land and try again.',
        );
      } else {
        onSaved(updated);
        onOpenChange(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't bind metadata: ${message}`);
    } finally {
      setBindingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Find on ScreenScraper</DialogTitle>
          <DialogDescription className="truncate" title={`${filename} · ${coreLabel}`}>
            {filename} · {coreLabel}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSearch();
          }}
        >
          <input
            type="text"
            className="flex-1 rounded border border-default bg-canvas px-2 py-1 text-body-sm text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Game name"
            autoFocus
          />
          <Button
            variant="primary"
            onClick={() => void handleSearch()}
            disabled={searching || searchTerm.trim() === ''}
          >
            {searching ? (
              <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
            ) : null}
            Search
          </Button>
        </form>

        <div className="max-h-[400px] overflow-y-auto">
          {errorMessage !== null ? (
            <p className="py-4 text-center text-body-sm text-fg-muted">
              {errorMessage}
            </p>
          ) : results === null ? (
            <p className="py-4 text-center text-body-sm text-fg-disabled">
              Enter a search term and press Search.
            </p>
          ) : (
            <ul className="grid gap-2">
              {results.map((game) => (
                <SearchResultItem
                  key={game.id}
                  game={game}
                  binding={bindingId === game.id}
                  onUse={() => void handleUseMatch(game)}
                />
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SearchResultItem(props: {
  readonly game: ScreenScraperGame;
  readonly binding: boolean;
  readonly onUse: () => void;
}): JSX.Element {
  const { game, binding, onUse } = props;
  const boxArtObjectUrl = useBoxArt(game.boxArtUrl);
  const synopsis =
    game.description !== null && game.description.length > 120
      ? `${game.description.slice(0, 120).trim()}…`
      : game.description;
  return (
    <li className="flex gap-3 rounded border border-subtle bg-elevated p-2">
      {boxArtObjectUrl !== null ? (
        <img
          src={boxArtObjectUrl}
          alt={game.name}
          className="h-20 w-20 shrink-0 rounded-sm object-contain"
          loading="lazy"
        />
      ) : (
        <div className="h-20 w-20 shrink-0 rounded-sm bg-overlay/40" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-body-sm font-medium text-fg">{game.name}</div>
        <div className="text-caption text-fg-muted">
          {[game.system, game.releaseDate?.slice(0, 4)]
            .filter((s): s is string => s !== null && s !== undefined && s !== '')
            .join(' · ')}
        </div>
        {synopsis !== null ? (
          <div className="text-caption text-fg-muted line-clamp-2">
            {synopsis}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-start">
        <Button variant="primary" onClick={onUse} disabled={binding}>
          {binding ? (
            <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          ) : null}
          Use this match
        </Button>
      </div>
    </li>
  );
}

/**
 * Strip parens/brackets/extension from a filename for the search
 * prefill. Mirrors the shape `filename-hint.ts` produces, but
 * inlined here since this is a renderer-only concern (we don't
 * want to import a main-process module).
 */
export function filenameToSearchTerm(filename: string): string {
  return filename
    .replace(/\.[a-z0-9]+$/i, '') // strip extension
    .replace(/\s*\([^)]*\)/gu, '') // strip (...)
    .replace(/\s*\[[^\]]*\]/gu, '') // strip [...]
    .replace(/\s+/gu, ' ')
    .trim();
}
