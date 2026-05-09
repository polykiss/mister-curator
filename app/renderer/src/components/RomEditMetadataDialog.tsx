import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import type { RomMetadata, UserMetadataOverride } from '@shared/metadata-types';

import { Button } from '@app/renderer/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';

/**
 * PR-D2 (PR #29) — edit-metadata modal.
 *
 * User-facing form for editing the per-ROM `userOverride` block:
 * name, year, genre, rating, tags, note. Each field defaults to the
 * current `display*` value (override-aware). On Save, the diff
 * against the source-resolved values is computed and only fields
 * the user actually changed get persisted to `userOverride` —
 * keeps cache records lean.
 *
 * Reset clears `userOverride` entirely → row reverts to source-only
 * display. Destructive but recoverable (the user can re-edit).
 *
 * Tags: comma-separated freeform input for v0.1. The chip-with-
 * autocomplete UI from the PR-D2 spec ships in a later round —
 * the persistent shape is `string[]` either way, so the storage
 * format isn't blocked.
 *
 * Save flow:
 *   1. Build the override object from changed fields.
 *   2. Call `window.mister.setRomMetadataOverride(path, override)`.
 *   3. Receive the updated `RomMetadata`; pass it back to the
 *      caller via `onSaved` so the row re-renders immediately.
 *   4. Close the dialog.
 *
 * Errors surface as toasts; the dialog stays open so the user can
 * retry or cancel.
 */
export interface RomEditMetadataDialogProps {
  /** The ROM's on-device path — primary key for the cache write. */
  readonly path: string;
  /** Display name for the dialog title (truncates if long). */
  readonly displayName: string;
  /**
   * The current cache record. Required — the modal can't open if
   * there's nothing to edit. Caller (RomsPane) gates on this.
   */
  readonly metadata: RomMetadata;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Called with the updated record after a successful save (or
   * Reset). Caller updates its local `metadataByPath` so the row
   * re-renders without a separate fetch.
   */
  readonly onSaved: (updated: RomMetadata) => void;
}

export function RomEditMetadataDialog(
  props: RomEditMetadataDialogProps,
): JSX.Element {
  const { path, displayName, metadata, open, onOpenChange, onSaved } = props;

  // Form state. Initialized from the merged display values so a row
  // with userOverride.name='X' opens showing 'X' in the field.
  const initial = computeInitialFormState(metadata);
  const [name, setName] = useState(initial.name);
  const [year, setYear] = useState(initial.year);
  const [genre, setGenre] = useState(initial.genre);
  const [rating, setRating] = useState(initial.rating);
  const [tagsText, setTagsText] = useState(initial.tagsText);
  const [note, setNote] = useState(initial.note);
  const [saving, setSaving] = useState(false);

  // Re-seed when the dialog opens for a different row.
  useEffect(() => {
    if (open) {
      const fresh = computeInitialFormState(metadata);
      setName(fresh.name);
      setYear(fresh.year);
      setGenre(fresh.genre);
      setRating(fresh.rating);
      setTagsText(fresh.tagsText);
      setNote(fresh.note);
    }
  }, [open, metadata]);

  async function handleSave(): Promise<void> {
    setSaving(true);
    try {
      const override = buildOverride(metadata, {
        name,
        year,
        genre,
        rating,
        tagsText,
        note,
      });
      const updated = await window.mister.setRomMetadataOverride(path, override);
      if (updated === null) {
        toast.error(
          'Couldn\'t save — no metadata record for this row yet. Wait for the prefetch to land and try again.',
        );
      } else {
        onSaved(updated);
        onOpenChange(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't save metadata: ${message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset(): Promise<void> {
    setSaving(true);
    try {
      const updated = await window.mister.setRomMetadataOverride(path, undefined);
      if (updated === null) {
        toast.error('Couldn\'t reset — no metadata record for this row.');
      } else {
        onSaved(updated);
        onOpenChange(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't reset metadata: ${message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit metadata</DialogTitle>
          <DialogDescription className="truncate" title={displayName}>
            {displayName}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <Field label="Name">
            <input
              type="text"
              className="w-full rounded border border-default bg-canvas px-2 py-1 text-body-sm text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={metadata.name}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Year">
              <input
                type="number"
                className="w-full rounded border border-default bg-canvas px-2 py-1 text-body-sm text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                placeholder={metadata.year !== null ? String(metadata.year) : '—'}
                min={1970}
                max={2100}
              />
            </Field>
            <Field label="Rating (0-10)">
              <input
                type="number"
                className="w-full rounded border border-default bg-canvas px-2 py-1 text-body-sm text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                value={rating}
                onChange={(e) => setRating(e.target.value)}
                placeholder={metadata.rating !== null ? String(metadata.rating) : '—'}
                min={0}
                max={10}
                step={0.1}
              />
            </Field>
          </div>

          <Field label="Genre">
            <input
              type="text"
              className="w-full rounded border border-default bg-canvas px-2 py-1 text-body-sm text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              placeholder={metadata.genre ?? '—'}
            />
          </Field>

          <Field
            label="Tags (comma-separated)"
            hint="Common: hack, fan-translation, improvement, alt, prototype, demo"
          >
            <input
              type="text"
              className="w-full rounded border border-default bg-canvas px-2 py-1 text-body-sm text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="hack, fan-translation"
            />
          </Field>

          <Field label="Note">
            <textarea
              rows={3}
              className="w-full resize-none rounded border border-default bg-canvas px-2 py-1 text-body-sm text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </form>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => void handleReset()}
            disabled={saving || metadata.userOverride === undefined}
            title="Clear all overrides — row reverts to source-resolved values."
          >
            Reset
          </Button>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <label className="grid gap-1">
      <span className="text-caption uppercase tracking-[0.08em] text-fg-muted">
        {props.label}
      </span>
      {props.children}
      {props.hint !== undefined ? (
        <span className="text-caption text-fg-disabled">{props.hint}</span>
      ) : null}
    </label>
  );
}

interface FormState {
  readonly name: string;
  readonly year: string;
  readonly genre: string;
  readonly rating: string;
  readonly tagsText: string;
  readonly note: string;
}

/**
 * Initialize the form from the current metadata record. Pre-fills
 * with the merged-display values so a row with an existing override
 * opens showing the override (the user is editing what they last
 * set, not the source).
 *
 * Number → string conversion is for the controlled-input shape;
 * `buildOverride` re-parses on save.
 */
function computeInitialFormState(metadata: RomMetadata): FormState {
  const o = metadata.userOverride;
  return {
    name: o?.name ?? metadata.name,
    year:
      o?.year !== undefined
        ? String(o.year)
        : metadata.year !== null
          ? String(metadata.year)
          : '',
    genre: o?.genre ?? metadata.genre ?? '',
    rating:
      o?.rating !== undefined
        ? String(o.rating)
        : metadata.rating !== null
          ? String(metadata.rating)
          : '',
    tagsText: o?.tags?.join(', ') ?? '',
    note: o?.note ?? '',
  };
}

/**
 * Build a `UserMetadataOverride` object from the form state, dropping
 * any field where the user-entered value matches the source value
 * (no need to persist a redundant override). Returns undefined when
 * every field matches the source — caller can shortcut to "no
 * override" instead of writing an empty block.
 *
 * Exported for testability.
 */
export function buildOverride(
  metadata: RomMetadata,
  form: FormState,
): UserMetadataOverride | undefined {
  const out: { -readonly [K in keyof UserMetadataOverride]: UserMetadataOverride[K] } = {};

  // Name — set when non-empty AND differs from source.
  const trimmedName = form.name.trim();
  if (trimmedName !== '' && trimmedName !== metadata.name) {
    out.name = trimmedName;
  }

  // Year — set when valid number AND differs from source.
  if (form.year.trim() !== '') {
    const yearNum = Number.parseInt(form.year, 10);
    if (Number.isFinite(yearNum) && yearNum !== metadata.year) {
      out.year = yearNum;
    }
  }

  // Genre — set when non-empty AND differs from source.
  const trimmedGenre = form.genre.trim();
  if (trimmedGenre !== '' && trimmedGenre !== (metadata.genre ?? '')) {
    out.genre = trimmedGenre;
  }

  // Rating — set when valid number AND differs from source.
  if (form.rating.trim() !== '') {
    const ratingNum = Number.parseFloat(form.rating);
    if (
      Number.isFinite(ratingNum) &&
      ratingNum >= 0 &&
      ratingNum <= 10 &&
      ratingNum !== metadata.rating
    ) {
      out.rating = ratingNum;
    }
  }

  // Tags — split, trim, dedupe, drop empties. Set only when
  // non-empty (an empty array signals "no tags" but the override
  // shouldn't store that — let the source's empty fall through).
  const tags = form.tagsText
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  const dedupedTags = Array.from(new Set(tags));
  if (dedupedTags.length > 0) {
    out.tags = dedupedTags;
  }

  // Note — set when non-empty (sources don't surface notes; any
  // user-entered text is an override).
  const trimmedNote = form.note.trim();
  if (trimmedNote !== '') {
    out.note = trimmedNote;
  }

  // Preserve existing jeuid override (set by search modal) if no
  // form field touches it. The edit modal doesn't expose jeuid
  // directly — it's the search-modal's domain.
  if (metadata.userOverride?.jeuid !== undefined) {
    out.jeuid = metadata.userOverride.jeuid;
  }

  return Object.keys(out).length === 0 ? undefined : out;
}
