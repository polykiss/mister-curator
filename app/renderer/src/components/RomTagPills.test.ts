import { describe, expect, it } from 'vitest';

import {
  classesForTag,
  MAX_VISIBLE_TAG_PILLS,
  RomTagPills,
} from '@app/renderer/src/components/RomTagPills';

/**
 * `classesForTag` is the per-tag color resolver. The component itself
 * uses the function-call test pattern (no jsdom) to assert the
 * rendered element shape.
 */

describe('classesForTag', () => {
  it('maps known tags to their accent classes', () => {
    expect(classesForTag('hack')).toContain('destructive');
    expect(classesForTag('fan-translation')).toContain('info');
    expect(classesForTag('improvement')).toContain('accent');
    expect(classesForTag('prototype')).toContain('warning');
  });

  it('lookup is case-insensitive', () => {
    expect(classesForTag('HACK')).toBe(classesForTag('hack'));
    expect(classesForTag('Fan-Translation')).toBe(
      classesForTag('fan-translation'),
    );
  });

  it('falls back to neutral classes for unknown tags', () => {
    const custom = classesForTag('my-custom-tag-12345');
    expect(custom).toContain('text-fg-muted');
  });

  it('alt / unlicensed / bootleg / demo / beta / preview all use neutral grey', () => {
    for (const tag of [
      'alt',
      'unlicensed',
      'bootleg',
      'demo',
      'beta',
      'preview',
    ]) {
      expect(classesForTag(tag)).toContain('text-fg-muted');
    }
  });
});

describe('RomTagPills — render shape (function-call pattern)', () => {
  // The component renders a single <span> wrapping per-tag <span>s.
  // We call it as a function and walk the tree to assert structure.

  it('returns null when no tags', () => {
    const result = RomTagPills({ tags: [] });
    expect(result).toBeNull();
  });

  it('renders one pill per visible tag (under MAX_VISIBLE)', () => {
    const result = RomTagPills({
      tags: ['hack', 'demo'],
    });
    const json = JSON.stringify(result);
    expect(json).toContain('hack');
    expect(json).toContain('demo');
  });

  it('collapses tail into +N overflow pill when > MAX_VISIBLE_TAG_PILLS', () => {
    const tags = ['hack', 'fan-translation', 'improvement', 'demo', 'beta'];
    expect(tags.length).toBeGreaterThan(MAX_VISIBLE_TAG_PILLS);
    const result = RomTagPills({ tags });
    const json = JSON.stringify(result);
    // First MAX_VISIBLE rendered.
    expect(json).toContain('hack');
    expect(json).toContain('fan-translation');
    expect(json).toContain('improvement');
    // Overflow pill renders count: React renders `+{hidden.length}`
    // as two children — string "+" and number 2 — so the JSON has
    // both. Check separately.
    expect(json).toContain('"+"');
    expect(json).toContain(',2');
    // Hidden tags appear in title attribute (hover tooltip).
    expect(json).toContain('demo, beta');
  });

  it('exactly MAX_VISIBLE tags renders no overflow pill', () => {
    const tags = ['hack', 'demo', 'beta'];
    expect(tags.length).toBe(MAX_VISIBLE_TAG_PILLS);
    const result = RomTagPills({ tags });
    const json = JSON.stringify(result);
    expect(json).toContain('hack');
    expect(json).toContain('demo');
    expect(json).toContain('beta');
    // No overflow → no `["+", N]` children pair.
    expect(json).not.toContain('"+"');
  });

  it('respects maxVisible override (test scaffolding)', () => {
    const tags = ['a', 'b', 'c', 'd'];
    const result = RomTagPills({
      tags,
      maxVisible: 2,
    });
    const json = JSON.stringify(result);
    expect(json).toContain('"a"');
    expect(json).toContain('"b"');
    // Two hidden → overflow "+2".
    expect(json).toContain('"+"');
    expect(json).toContain('c, d');
  });
});

describe('MAX_VISIBLE_TAG_PILLS', () => {
  it('is 3 — the spec-pinned default', () => {
    expect(MAX_VISIBLE_TAG_PILLS).toBe(3);
  });
});
