import type { JSX } from 'react';

const CELLS: readonly (readonly [number, number])[] = [
  [0, 0], [4, 0],
  [0, 1], [1, 1], [3, 1], [4, 1],
  [0, 2], [2, 2], [4, 2],
  [0, 3], [4, 3],
  [0, 4], [4, 4],
];

/**
 * 8-bit "M" monogram in `accent`. Identity only — the one sanctioned
 * non-CTA use of accent (SYSTEM.md §2 accent note + §5 brand mark).
 */
export function PixelM({ size = 28 }: { readonly size?: number }): JSX.Element {
  const blk = 8;
  const gap = 2;
  const span = 4 * (blk + gap) + blk;
  const off = (50 - span) / 2;
  return (
    <svg width={size} height={size} viewBox="0 0 50 50" fill="none" aria-hidden>
      {CELLS.map(([c, r], i) => (
        <rect
          key={i}
          x={off + c * (blk + gap)}
          y={off + r * (blk + gap)}
          width={blk}
          height={blk}
          rx={1.8}
          style={{ fill: 'hsl(var(--accent))' }}
          opacity={r === 0 ? 1 : 0.92 - r * 0.04}
        />
      ))}
    </svg>
  );
}

/**
 * Brand lockup: pixel-M monogram tile + monochrome "MiSTerCurator"
 * wordmark. The lime lives only in the monogram (and the primary CTA),
 * keeping the one-accent discipline — the wordmark stays `fg-primary`.
 *
 * `tile` sizes the monogram tile; the wordmark uses `text-display` by
 * default. Pass `compact` to render at `text-heading` (20px) for the
 * browser header's 56px chrome.
 */
export function BrandMark({
  tile = 44,
  compact = false,
}: {
  readonly tile?: number;
  readonly compact?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center gap-4">
      <div
        className="grid shrink-0 place-items-center overflow-hidden border border-white/12 bg-elevated"
        style={{ width: tile, height: tile, borderRadius: Math.round(tile * 0.26) }}
      >
        <PixelM size={Math.round(tile * 0.62)} />
      </div>
      <h1 className={compact ? 'text-heading tracking-[-0.02em] text-fg' : 'text-display tracking-[-0.02em] text-fg'}>
        MiSTerCurator
      </h1>
    </div>
  );
}
