import { describe, expect, it } from 'vitest';

import {
  formatRating,
  pickPrimaryGenre,
} from '@app/renderer/src/lib/rom-metadata-format';

describe('pickPrimaryGenre', () => {
  it('returns null for null / empty input', () => {
    expect(pickPrimaryGenre(null)).toBeNull();
    expect(pickPrimaryGenre('')).toBeNull();
  });

  it('returns the only token unchanged for a single-genre string', () => {
    expect(pickPrimaryGenre('Platform')).toBe('Platform');
  });

  it('takes the first comma-separated token', () => {
    expect(pickPrimaryGenre('Platform, Action, Adventure')).toBe('Platform');
  });

  it('takes the first slash-separated token', () => {
    expect(pickPrimaryGenre('Action / Adventure')).toBe('Action');
  });

  it('honours both separators in the same string', () => {
    // "Platform, Action / Adventure" should produce "Platform" — the
    // comma is hit first.
    expect(pickPrimaryGenre('Platform, Action / Adventure')).toBe('Platform');
    // "Action / Adventure, Platform" should produce "Action".
    expect(pickPrimaryGenre('Action / Adventure, Platform')).toBe('Action');
  });

  it('trims whitespace around the picked token', () => {
    expect(pickPrimaryGenre('   Platform   , Action')).toBe('Platform');
  });

  it('returns null when the first token is whitespace-only', () => {
    expect(pickPrimaryGenre(', Action')).toBeNull();
  });
});

describe('formatRating', () => {
  it('returns null for null input', () => {
    expect(formatRating(null)).toBeNull();
  });

  it('renders a whole-number rating without a trailing .0', () => {
    expect(formatRating(9)).toBe('9/10');
    expect(formatRating(0)).toBe('0/10');
    expect(formatRating(10)).toBe('10/10');
  });

  it('renders a fractional rating to one decimal place', () => {
    expect(formatRating(9.5)).toBe('9.5/10');
    expect(formatRating(7.25)).toBe('7.3/10'); // toFixed(1) rounding
  });

  it('handles negative or out-of-range values literally', () => {
    // No clamping — formatter trusts upstream. Round 5 of PR #16
    // already gates on the SS /20 normalisation, so out-of-range is a
    // contract violation rather than a user-facing concern.
    expect(formatRating(-1)).toBe('-1/10');
    expect(formatRating(11)).toBe('11/10');
  });
});
