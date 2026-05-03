import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge ships with knowledge of Tailwind's *default* font-size
// scale (text-xs, text-sm, text-base, text-lg, text-xl, …). Anything
// else under `text-*` is treated as a text-color and deduped against
// other text-color classes.
//
// Our custom scale (`text-caption`, `text-body`, `text-body-sm`,
// `text-body-lg`, `text-heading-sm`, `text-heading`, `text-heading-lg`,
// `text-display`) lives in `tailwind.config.cjs#fontSize`. Without
// teaching twMerge that those are *sizes*, it sees `text-body-sm` and
// `text-accent-fg` as both belonging to the text-color group and drops
// the earlier one — which is how the primary button lost its
// `text-accent-fg` and rendered with body-default fg color (white on
// signal-green) in Round 1.
//
// Adding the custom names to the `font-size` group keeps colors and
// sizes in their own conflict buckets so the variant + size emissions
// from cva don't trample each other.
const customMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'caption',
            'body-sm',
            'body',
            'body-lg',
            'heading-sm',
            'heading',
            'heading-lg',
            'display',
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return customMerge(clsx(inputs));
}
