import { describe, expect, it } from 'vitest';

import type { ArcadeMraMeta } from '@shared/arcade-mra-parse';

import {
  groupByPrimaryZipBasename,
  resolvePrimaryZipBasename,
} from '@app/main/services/arcade-prefetch-paths';

function mra(
  relativePath: string,
  requiredZips: readonly (readonly string[])[],
  setname?: string,
): ArcadeMraMeta {
  return {
    relativePath,
    displayName: relativePath.split('/').pop()!,
    hidden: false,
    requiredZips,
    rbf: 'r',
    setname,
  };
}

describe('resolvePrimaryZipBasename', () => {
  it('returns the first existing alternative in the first block (single-block, fallback list)', () => {
    // Galaga shape: one <rom> block with pipe-fallback alternatives.
    const entry = mra('Galaga.mra', [
      ['galaga.zip', 'galagamw.zip', 'namco51.zip'],
    ]);
    expect(
      resolvePrimaryZipBasename(entry, new Set(['galaga.zip'])),
    ).toBe('galaga.zip');
  });

  it('skips to the next fallback alternative when the canonical name is missing (clone-only collection)', () => {
    // User has galagamw.zip (clone) but not galaga.zip (parent).
    const entry = mra('Galaga.mra', [
      ['galaga.zip', 'galagamw.zip'],
    ]);
    expect(
      resolvePrimaryZipBasename(entry, new Set(['galagamw.zip'])),
    ).toBe('galagamw.zip');
  });

  it('falls through to the next block when the first block has no available alternatives', () => {
    // Synthetic multi-block .mra. Block 0 has only missing alts; block 1
    // has an alt that exists. The first-existing-overall wins.
    const entry = mra('Multi.mra', [
      ['missing-a.zip', 'missing-b.zip'],
      ['present.zip'],
    ]);
    expect(
      resolvePrimaryZipBasename(entry, new Set(['present.zip'])),
    ).toBe('present.zip');
  });

  it('returns null when no alternative across any block exists', () => {
    const entry = mra('Lost.mra', [['lost.zip'], ['alsolost.zip']]);
    expect(resolvePrimaryZipBasename(entry, new Set())).toBeNull();
  });

  it('returns null for a no-zip (TTL / discrete-logic) .mra', () => {
    // computeArcadePlayability classifies this as `no-roms-needed`;
    // upstream filters to `playable` before calling this helper, but
    // be defensive: an empty requiredZips returns null cleanly.
    const entry = mra('Computer Space.mra', []);
    expect(resolvePrimaryZipBasename(entry, new Set(['anything.zip']))).toBeNull();
  });
});

describe('groupByPrimaryZipBasename', () => {
  it('groups two `.mras` that resolve to the same zip into one bucket (the dedupe contract)', () => {
    // Parent + clone often reference the same primary zip in their
    // fallback lists. The dedupe is by primary zip basename: hash
    // once, look up SS once, fan the metadata across every .mra
    // mapped to it.
    const parent = mra('Donkey Kong.mra', [['dkong.zip']]);
    const clone = mra('Donkey Kong (US).mra', [
      ['dkongus.zip', 'dkong.zip'],
    ]);
    const groups = groupByPrimaryZipBasename(
      [parent, clone],
      new Set(['dkong.zip']),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.zipBasename).toBe('dkong.zip');
    expect(
      groups[0]?.mras.map((m) => m.relativePath).slice().sort(),
    ).toEqual(['Donkey Kong (US).mra', 'Donkey Kong.mra']);
  });

  it('emits separate buckets when two .mras resolve to different zips', () => {
    const a = mra('Pacman.mra', [['pacman.zip']]);
    const b = mra('MsPacman.mra', [['mspacman.zip']]);
    const groups = groupByPrimaryZipBasename(
      [a, b],
      new Set(['pacman.zip', 'mspacman.zip']),
    );
    expect(groups).toHaveLength(2);
    // Buckets sorted by zipBasename for determinism.
    expect(groups.map((g) => g.zipBasename)).toEqual([
      'mspacman.zip',
      'pacman.zip',
    ]);
  });

  it('drops `.mras` that resolve to no zip (the playability scan already filtered, defensive only)', () => {
    const ok = mra('Galaga.mra', [['galaga.zip']]);
    const lost = mra('Lost.mra', [['lost.zip']]);
    const groups = groupByPrimaryZipBasename(
      [ok, lost],
      new Set(['galaga.zip']),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.zipBasename).toBe('galaga.zip');
  });

  it('within-bucket `.mras` are sorted by relativePath for stable prefetch event order', () => {
    const a = mra('B.mra', [['shared.zip']]);
    const b = mra('A.mra', [['shared.zip']]);
    const c = mra('C.mra', [['shared.zip']]);
    const groups = groupByPrimaryZipBasename(
      [a, b, c],
      new Set(['shared.zip']),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.mras.map((m) => m.relativePath)).toEqual([
      'A.mra',
      'B.mra',
      'C.mra',
    ]);
  });
});
