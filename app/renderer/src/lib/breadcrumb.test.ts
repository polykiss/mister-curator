import { describe, expect, it } from 'vitest';

import {
  computeBackRow,
  computeBreadcrumb,
  subPathAtDepth,
} from '@app/renderer/src/lib/breadcrumb';

describe('computeBreadcrumb', () => {
  it('returns just the core name at the core root', () => {
    expect(computeBreadcrumb('Saturn', '')).toEqual([
      { label: 'Saturn', depth: 0, current: true },
    ]);
  });

  it('marks only the last segment current', () => {
    const segs = computeBreadcrumb('Saturn', 'Folder A/Folder B');
    expect(segs.map((s) => s.current)).toEqual([false, false, true]);
  });

  it('builds one segment per slash-separated part with monotonic depths', () => {
    const segs = computeBreadcrumb('NEOGEO', '1 World A-Z');
    expect(segs).toEqual([
      { label: 'NEOGEO', depth: 0, current: false },
      { label: '1 World A-Z', depth: 1, current: true },
    ]);
  });

  it('handles deep nesting (2 levels) with correct depths', () => {
    const segs = computeBreadcrumb('Saturn', 'Folder A/Folder B');
    expect(segs).toEqual([
      { label: 'Saturn', depth: 0, current: false },
      { label: 'Folder A', depth: 1, current: false },
      { label: 'Folder B', depth: 2, current: true },
    ]);
  });

  it('strips archive extensions from folder labels for display consistency', () => {
    // Edge case: a container folder accidentally named with a `.zip`
    // suffix should still render cleanly in the breadcrumb.
    const segs = computeBreadcrumb('NEOGEO', 'Stuff.zip');
    expect(segs[1]?.label).toBe('Stuff');
  });

  it('preserves non-archive extensions in folder labels', () => {
    const segs = computeBreadcrumb('Saturn', 'Game.Folder');
    expect(segs[1]?.label).toBe('Game.Folder');
  });
});

describe('subPathAtDepth', () => {
  it('depth 0 returns the core root (empty string)', () => {
    expect(subPathAtDepth('Folder A/Folder B', 0)).toBe('');
  });

  it('depth N returns the first N segments joined', () => {
    expect(subPathAtDepth('Folder A/Folder B/Folder C', 1)).toBe('Folder A');
    expect(subPathAtDepth('Folder A/Folder B/Folder C', 2)).toBe(
      'Folder A/Folder B',
    );
  });

  it('depth at or beyond the path length returns the original path', () => {
    expect(subPathAtDepth('Folder A/Folder B', 2)).toBe('Folder A/Folder B');
    expect(subPathAtDepth('Folder A/Folder B', 5)).toBe('Folder A/Folder B');
  });

  it('negative depth clamps to the core root', () => {
    expect(subPathAtDepth('Folder A', -1)).toBe('');
  });

  it('returns the empty string when the path is already empty', () => {
    expect(subPathAtDepth('', 0)).toBe('');
    expect(subPathAtDepth('', 5)).toBe('');
  });

  it('clicking a breadcrumb 2 levels up from a 3-deep path lands at depth 2', () => {
    // Spec scenario: "clicking a breadcrumb segment two levels up
    // calls the navigation handler with the right depth". Two levels
    // up from depth-3 means depth = 3 - 2 = 1.
    const startPath = 'A/B/C';
    const targetDepth = 1; // i.e. 2 levels up from depth 3
    expect(subPathAtDepth(startPath, targetDepth)).toBe('A');
  });
});

describe('computeBackRow', () => {
  it('returns null at the core root (no row should render)', () => {
    expect(computeBackRow('Saturn', '')).toBeNull();
  });

  it('one level deep — parent is the core', () => {
    expect(computeBackRow('Saturn', 'Panzer Dragoon Saga (USA)')).toEqual({
      targetSubPath: '',
      parentLabel: 'Saturn',
    });
  });

  it('two levels deep — parent is the immediate folder above', () => {
    expect(computeBackRow('NEOGEO', '1 World A-Z/Sub')).toEqual({
      targetSubPath: '1 World A-Z',
      parentLabel: '1 World A-Z',
    });
  });

  it('three levels deep — parent is the second-deepest segment', () => {
    expect(computeBackRow('NEOGEO', 'A/B/C')).toEqual({
      targetSubPath: 'A/B',
      parentLabel: 'B',
    });
  });

  it('strips archive extensions from the parent label', () => {
    const row = computeBackRow('NEOGEO', 'Stuff.zip/inner');
    expect(row).not.toBeNull();
    expect(row?.parentLabel).toBe('Stuff');
  });
});
