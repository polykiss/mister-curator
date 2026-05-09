import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * PR-D2 round 2 commit 2 — "Find on ScreenScraper..." menu entry must
 * be available on every row regardless of metadata state.
 *
 * Round-1 (PR #29) shipped this entry with `disabled: !hasMetadata`,
 * which made the entry greyed-out on exactly the rows that NEEDED it
 * — the source='none' rows where the auto-binder missed.
 *
 * The buildMenuItems function is a closure over RomsPane state, so a
 * source-string scan is the right test pattern here (RomsPane has no
 * jsdom-based test infra). The contract is small: the menu push for
 * "Find on ScreenScraper" must NOT carry a `disabled:` key.
 */

const SOURCE = readFileSync(
  resolve(__dirname, 'RomsPane.tsx'),
  'utf8',
);

describe('RomsPane — Find on ScreenScraper menu entry (PR-D2 r2 c2)', () => {
  it('"Find on ScreenScraper" menu push has no disabled: key', () => {
    // Capture the items.push({...}) block whose label starts with the
    // exact "Find on ScreenScraper" string (matches both with and
    // without the ★ prefix wrapper since the prefix is dynamic).
    const blockMatch = SOURCE.match(
      /items\.push\(\{[^}]*Find on ScreenScraper[^}]*\}\)/s,
    );
    expect(blockMatch).not.toBeNull();
    const block = blockMatch![0];
    // No disabled: key in this block — the entry must always be
    // clickable. (A disabled key is the regression we just fixed.)
    expect(block).not.toMatch(/\bdisabled:/);
  });

  it('label includes a ★ recommended prefix for source=none / missing-metadata rows', () => {
    // The prefix is the surfaced affordance — without it, the user has
    // no UI signal that this menu entry is the right next step for an
    // unmatched row. Pin it as a contract.
    expect(SOURCE).toContain('★ Find on ScreenScraper...');
  });

  it('isUnmatched gate fires on no-metadata OR source==="none"', () => {
    // The two states that mean "auto-binder didn't bind this row":
    // (a) the prefetch hasn't landed yet → no metadata at all; or
    // (b) the prefetch ran and explicitly returned no match (source='none').
    expect(SOURCE).toMatch(/sourceState === 'none'/);
    expect(SOURCE).toMatch(/!hasMetadata \|\| sourceState === 'none'/);
  });
});
