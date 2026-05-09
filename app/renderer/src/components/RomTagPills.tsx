import type { JSX } from 'react';

import { cn } from '@app/renderer/src/lib/cn';

/**
 * PR-D2 (PR #29) — tag pills for the row UI.
 *
 * Renders the user-set tags from `userOverride.tags` as small colored
 * pills next to the row's title. Caps visible pills at MAX_VISIBLE
 * (default 3); additional tags collapse into a single "+N" pill
 * with the full list in its `title=` for a hover tooltip.
 *
 * Color mapping is per-tag-name. Unknown tags render with the neutral
 * "custom" tint. Map is intentionally tight — common-pattern tags
 * (hack, fan-translation, etc.) get accent colors; the user can write
 * any tag they want and it just renders neutrally.
 */

/** Max pills rendered before collapsing the tail into a "+N" overflow. */
export const MAX_VISIBLE_TAG_PILLS = 3;

/**
 * Per-tag color map. Keys are case-insensitive (looked up via
 * lowercased tag). Values are Tailwind class strings combining
 * background, text, and border tokens. Unknown tags fall back to
 * `'custom'`.
 */
const TAG_COLOR_CLASSES: Readonly<Record<string, string>> = {
  hack: 'bg-destructive/15 text-destructive border-destructive/40',
  'fan-translation': 'bg-info/15 text-info border-info/40',
  improvement: 'bg-accent/15 text-accent border-accent/40',
  alt: 'bg-overlay text-fg-muted border-default',
  prototype: 'bg-warning/15 text-warning border-warning/40',
  unlicensed: 'bg-overlay text-fg-muted border-default',
  bootleg: 'bg-overlay text-fg-muted border-default',
  demo: 'bg-overlay text-fg-muted border-default',
  beta: 'bg-overlay text-fg-muted border-default',
  preview: 'bg-overlay text-fg-muted border-default',
};
const CUSTOM_TAG_CLASSES = 'bg-overlay text-fg-muted border-default';

/**
 * Resolve the color classes for a tag. Exported for testability.
 */
export function classesForTag(tag: string): string {
  return TAG_COLOR_CLASSES[tag.toLowerCase()] ?? CUSTOM_TAG_CLASSES;
}

export function RomTagPills(props: {
  readonly tags: readonly string[];
  /**
   * Override the visible cap. Defaults to MAX_VISIBLE_TAG_PILLS. The
   * row layout calls with the default; only test scaffolding tweaks
   * this.
   */
  readonly maxVisible?: number;
}): JSX.Element | null {
  const { tags, maxVisible = MAX_VISIBLE_TAG_PILLS } = props;
  if (tags.length === 0) return null;
  const visible = tags.slice(0, maxVisible);
  const hidden = tags.slice(maxVisible);
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {visible.map((tag) => (
        <span
          key={tag}
          className={cn(
            'inline-block rounded border px-1 text-caption uppercase tracking-[0.06em]',
            classesForTag(tag),
          )}
          title={tag}
        >
          {tag}
        </span>
      ))}
      {hidden.length > 0 ? (
        <span
          className={cn(
            'inline-block rounded border px-1 text-caption uppercase tracking-[0.06em]',
            CUSTOM_TAG_CLASSES,
          )}
          title={hidden.join(', ')}
        >
          +{hidden.length}
        </span>
      ) : null}
    </span>
  );
}
