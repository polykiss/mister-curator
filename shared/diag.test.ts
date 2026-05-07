import { describe, expect, it } from 'vitest';

import {
  emit,
  InMemoryDiagnosticsCollector,
  serializeReport,
  type DiagRecord,
  type DiagReport,
} from '@shared/diag';

describe('emit', () => {
  it('is a no-op when no collector is configured', () => {
    expect(() =>
      emit(undefined, {
        kind: 'rbf',
        category: 'Console',
        type: 'file',
        filename: 'NES.rbf',
        fullPath: '/media/fat/_Console/NES.rbf',
        extractedPrefix: 'NES',
        hasLeadingDot: false,
      }),
    ).not.toThrow();
  });

  it('forwards the record to the collector when one is provided', () => {
    const collector = new InMemoryDiagnosticsCollector();
    emit(collector, {
      kind: 'core-entry',
      coreId: 'NES',
      name: 'NES',
      category: 'Console',
      romCount: 9,
      hiddenCount: 0,
      recursiveRomCount: 9,
      recursiveHiddenCount: 0,
      gamesDirExists: true,
      gamesDirHidden: false,
      gamesDirName: 'NES',
      hasAnyVisibleRbf: true,
      rbfPaths: ['/media/fat/_Console/NES.rbf'],
    });
    expect(collector.size()).toBe(1);
    expect(collector.toArray()[0]?.kind).toBe('core-entry');
  });

  it('swallows collector errors so a misbehaving listener never breaks the matcher', () => {
    const blowupCollector = {
      emit(): void {
        throw new Error('boom');
      },
    };
    expect(() =>
      emit(blowupCollector, {
        kind: 'discovery',
        path: '/media/fat/_Console',
        entryType: 'dir',
        note: 'category-like dir at /media/fat root',
      }),
    ).not.toThrow();
  });
});

describe('InMemoryDiagnosticsCollector', () => {
  it('starts empty', () => {
    const c = new InMemoryDiagnosticsCollector();
    expect(c.size()).toBe(0);
    expect(c.toArray()).toEqual([]);
  });

  it('byKind returns only records of the requested discriminator', () => {
    const c = new InMemoryDiagnosticsCollector();
    c.emit({
      kind: 'rbf',
      category: 'Console',
      type: 'file',
      filename: 'NES.rbf',
      fullPath: '/media/fat/_Console/NES.rbf',
      extractedPrefix: 'NES',
      hasLeadingDot: false,
    });
    c.emit({
      kind: 'games-dir',
      rawName: 'NES',
      visibleName: 'NES',
      isHidden: false,
      fileCount: 9,
      dirCount: 0,
    });
    c.emit({
      kind: 'rbf',
      category: 'Console',
      type: 'file',
      filename: 'SNES.rbf',
      fullPath: '/media/fat/_Console/SNES.rbf',
      extractedPrefix: 'SNES',
      hasLeadingDot: false,
    });

    const rbfs = c.byKind('rbf');
    expect(rbfs).toHaveLength(2);
    expect(rbfs.map((r) => r.extractedPrefix)).toEqual(['NES', 'SNES']);

    const dirs = c.byKind('games-dir');
    expect(dirs).toHaveLength(1);
    expect(dirs[0]?.visibleName).toBe('NES');
  });

  it('toArray returns a defensive copy', () => {
    const c = new InMemoryDiagnosticsCollector();
    c.emit({
      kind: 'discovery',
      path: '/media/fat/_Console (autoboot)',
      entryType: 'dir',
      note: 'category-like dir at /media/fat root',
    });
    const snapshot = c.toArray();
    c.emit({
      kind: 'discovery',
      path: '/media/fat/menu.rbf',
      entryType: 'file',
      note: 'rbf/mgl at /media/fat root',
    });
    expect(snapshot).toHaveLength(1);
    expect(c.size()).toBe(2);
  });
});

describe('serializeReport', () => {
  it('produces parseable JSON with 2-space indent', () => {
    const report: DiagReport = {
      header: {
        version: 1,
        mister: { host: '192.168.1.42', port: 22, username: 'root' },
        startedAt: '2026-05-08T12:34:56.789Z',
        elapsedMs: 1234,
        subprocessForks: 2,
      },
      records: [
        {
          kind: 'rbf',
          category: 'Console',
          type: 'file',
          filename: 'NES.rbf',
          fullPath: '/media/fat/_Console/NES.rbf',
          extractedPrefix: 'NES',
          hasLeadingDot: false,
        },
      ],
      cores: [],
    };
    const text = serializeReport(report);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('  "version": 1');
    expect(text).toContain('  "records": [');
    const reparsed = JSON.parse(text) as DiagReport;
    expect(reparsed.records).toHaveLength(1);
    expect(reparsed.records[0]?.kind).toBe('rbf');
  });

  it('shape contract: every record carries a `kind` discriminator', () => {
    // This test is a structural anchor — if a future record kind is
    // added without a `kind` field the tests catch it before
    // production hits a malformed grep target.
    const records: DiagRecord[] = [
      {
        kind: 'rbf',
        category: 'Console',
        type: 'file',
        filename: 'X.rbf',
        fullPath: '/media/fat/_Console/X.rbf',
        extractedPrefix: 'X',
        hasLeadingDot: false,
      },
      {
        kind: 'games-dir',
        rawName: 'X',
        visibleName: 'X',
        isHidden: false,
        fileCount: 0,
        dirCount: 0,
      },
      {
        kind: 'match-attempt',
        key: 'X',
        lowerKey: 'x',
        groupSize: 1,
        groupIds: ['X'],
        outcome: 'kept-singleton',
      },
      {
        kind: 'system-filter',
        coreId: 'X',
        path: 'a.bin',
        entryType: 'file',
        isAutoSystem: false,
        isMarkedSystem: false,
        decision: 'kept',
      },
      {
        kind: 'recursive-count',
        coreId: 'X',
        topLevelEntry: 'a.bin',
        entryType: 'file',
        contributesCount: 1,
        contributesHiddenCount: 0,
        reason: 'top-level file counts as 1',
      },
      {
        kind: 'core-entry',
        coreId: 'X',
        name: 'X',
        category: 'Console',
        romCount: 0,
        hiddenCount: 0,
        recursiveRomCount: 0,
        recursiveHiddenCount: 0,
        gamesDirExists: false,
        gamesDirHidden: false,
        gamesDirName: undefined,
        hasAnyVisibleRbf: true,
        rbfPaths: ['/media/fat/_Console/X.rbf'],
      },
      {
        kind: 'discovery',
        path: '/media/fat/_Console (autoboot)',
        entryType: 'dir',
        note: 'category-like dir at /media/fat root',
      },
      {
        kind: 'shell-raw',
        source: 'list-all-cores',
        stdout: '',
        stderr: '',
        exitCode: 0,
        elapsedMs: 100,
      },
    ];
    for (const r of records) {
      expect(typeof r.kind).toBe('string');
    }
  });
});
