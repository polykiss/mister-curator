import { describe, expect, it } from 'vitest';

import { MisterConnectionError } from '@shared/types';
import type { MisterProfile } from '@shared/types';

import {
  formatBytes,
  friendlyConnectionError,
  stripLeadingDot,
} from '@app/renderer/src/lib/format';

const profile: MisterProfile = {
  id: 'p',
  name: 'Living Room',
  host: '192.168.1.42',
  port: 22,
  username: 'root',
  authMethod: 'password',
};

describe('friendlyConnectionError', () => {
  it('formats unreachable with the host inline', () => {
    const msg = friendlyConnectionError(
      new MisterConnectionError('unreachable', 'whatever'),
      profile,
    );
    expect(msg).toContain('192.168.1.42');
    expect(msg).not.toContain('whatever');
  });

  it('falls back to a generic host name when no profile is supplied', () => {
    const msg = friendlyConnectionError(
      new MisterConnectionError('unreachable', 'whatever'),
    );
    expect(msg).toContain('the MiSTer');
  });

  it('returns the generic auth_failed message regardless of underlying message', () => {
    const msg = friendlyConnectionError(
      new MisterConnectionError('auth_failed', 'Server replied 401'),
    );
    expect(msg).toMatch(/Login failed/i);
  });

  it('returns the generic not_a_mister message', () => {
    const msg = friendlyConnectionError(
      new MisterConnectionError('not_a_mister', 'irrelevant'),
    );
    expect(msg).toMatch(/MiSTer/);
    expect(msg).toMatch(/games/);
  });

  it('falls through to the underlying message for unknown', () => {
    const msg = friendlyConnectionError(
      new MisterConnectionError('unknown', 'Disk on fire'),
    );
    expect(msg).toBe('Disk on fire');
  });

  it('uses the message from a generic Error', () => {
    expect(friendlyConnectionError(new Error('boom'))).toBe('boom');
  });

  it('returns a generic message for non-Error throwables', () => {
    expect(friendlyConnectionError({ random: 1 })).toBe('Unexpected error.');
    expect(friendlyConnectionError('a string')).toBe('Unexpected error.');
  });
});

describe('formatBytes', () => {
  it('formats sub-kilobyte values in bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats kilobyte-range values with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats megabyte and gigabyte ranges', () => {
    expect(formatBytes(1_572_864)).toBe('1.5 MB');
    expect(formatBytes(2_147_483_648)).toBe('2.0 GB');
  });

  it('drops the decimal once the magnitude reaches three digits', () => {
    expect(formatBytes(150 * 1024)).toBe('150 KB');
  });

  it('returns an em-dash for invalid sizes', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('stripLeadingDot', () => {
  it('strips a single leading dot', () => {
    expect(stripLeadingDot('.foo')).toBe('foo');
  });

  it('leaves non-dotfiles untouched', () => {
    expect(stripLeadingDot('foo')).toBe('foo');
  });

  it('only strips one dot', () => {
    expect(stripLeadingDot('..foo')).toBe('.foo');
  });
});
