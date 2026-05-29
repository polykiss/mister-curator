import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { diffMetadataByPath } from '@app/renderer/src/components/roms-adapter';

const SOURCE = readFileSync(resolve(__dirname, 'roms-adapter.tsx'), 'utf8');

// ─── Fix 1: diff instead of unconditional wipe ───────────────────────────────

describe('fix/render-cascade-hide-unhide — Fix 1: diffMetadataByPath', () => {
  it('roms ref change with identical path set keeps all entries intact', () => {
    const prev = {
      '/games/SNES/mario.smc': { metadata: null, error: false },
      '/games/SNES/sonic.smc': { metadata: null, error: false },
    };
    const paths = new Set(['/games/SNES/mario.smc', '/games/SNES/sonic.smc']);
    const result = diffMetadataByPath(prev, paths);
    expect(result).toEqual(prev);
  });

  it('roms ref change with one path removed drops only that entry', () => {
    const mario = { metadata: null, error: false };
    const sonic = { metadata: null, error: false };
    const prev = {
      '/games/SNES/mario.smc': mario,
      '/games/SNES/sonic.smc': sonic,
    };
    // sonic is no longer in the new list
    const paths = new Set(['/games/SNES/mario.smc']);
    const result = diffMetadataByPath(prev, paths);
    expect(result).toEqual({ '/games/SNES/mario.smc': mario });
    expect(result['/games/SNES/sonic.smc']).toBeUndefined();
  });

  it('preserves entry values by reference (no deep copy)', () => {
    const entry = { metadata: null, error: false };
    const prev = { '/a': entry };
    const result = diffMetadataByPath(prev, new Set(['/a']));
    expect(result['/a']).toBe(entry);
  });

  it('returns empty object when newPaths is empty', () => {
    const prev = { '/a': { metadata: null, error: false } };
    const result = diffMetadataByPath(prev, new Set());
    expect(result).toEqual({});
  });

  it('returns empty object when prev is empty', () => {
    const result = diffMetadataByPath({}, new Set(['/a', '/b']));
    expect(result).toEqual({});
  });

  it('main prefetch effect uses diffMetadataByPath instead of setMetadataByPath({})', () => {
    // Guard against regression to unconditional wipe.
    // The diff call must appear inside the effect; the wipe form must
    // only appear in the empty-roms early-return branch.
    expect(SOURCE).toContain('diffMetadataByPath(prev, filePathSet)');
  });
});

// ─── Fix 2: rAF batching ─────────────────────────────────────────────────────

describe('fix/render-cascade-hide-unhide — Fix 2: rAF coalescing', () => {
  it('streamed-event listener accumulates into pendingBatchRef', () => {
    expect(SOURCE).toContain('pendingBatchRef.current[event.path]');
  });

  it('schedules a requestAnimationFrame flush when none is pending', () => {
    expect(SOURCE).toContain('requestAnimationFrame');
    // Guards: only one rAF is in flight at a time.
    expect(SOURCE).toContain('rafHandleRef.current === null');
  });

  it('effect cleanup cancels the pending rAF and clears the batch', () => {
    expect(SOURCE).toContain('cancelAnimationFrame(rafHandleRef.current)');
    expect(SOURCE).toContain('pendingBatchRef.current = {}');
  });
});

// ─── Fix 3: scroll-restore depends on romScrollKey, not presentableRoms ──────

describe('fix/render-cascade-hide-unhide — Fix 3: scroll-restore isolation', () => {
  it('declares romScrollKey memo', () => {
    expect(SOURCE).toMatch(/const romScrollKey = useMemo/);
  });

  it('romScrollKey does NOT include metadataByPath in its deps', () => {
    // Extract the romScrollKey useMemo deps array. The arrow function body
    // ends with `}`, so the pattern uses `}, [` (not `), [`).
    const match = SOURCE.match(
      /const romScrollKey = useMemo\([\s\S]*?\}, \[([^\]]*)\]\)/,
    );
    expect(match).not.toBeNull();
    const deps = match![1];
    expect(deps).not.toContain('metadataByPath');
    expect(deps).not.toContain('sortState');
  });

  it('scroll-restore useLayoutEffect depends on romScrollKey, not presentableRoms', () => {
    // The restore block has a specific sentinel we can key on.
    const restoreBlock = SOURCE.match(
      /pendingScrollRestoreRef\.current = null;[\s\S]*?}, \[([^\]]*)\]\);/,
    );
    expect(restoreBlock).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const dep = restoreBlock![1]!.trim();
    expect(dep).toBe('romScrollKey');
  });
});
