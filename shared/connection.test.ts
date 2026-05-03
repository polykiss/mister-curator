import { describe, expect, it } from 'vitest';

import {
  backoffDelayMs,
  CONNECTING_REVEAL_MS,
  formatConnectingMessage,
  formatConnectionErrorMessage,
  RECONNECT_BACKOFF_MS,
  STILL_CONNECTING_MS,
} from '@shared/connection';
import type { MisterProfile } from '@shared/types';

const profile: MisterProfile = {
  id: 'home',
  name: 'Living Room MiSTer',
  host: '192.168.1.50',
  port: 22,
  username: 'root',
  authMethod: 'password',
};

describe('formatConnectionErrorMessage', () => {
  it('produces a network-friendly message for unreachable', () => {
    const msg = formatConnectionErrorMessage('unreachable', { profile });
    expect(msg).toContain('Living Room MiSTer');
    expect(msg).toContain('192.168.1.50');
    expect(msg).toContain('powered on');
  });

  it('points at the profile for auth_failed', () => {
    const msg = formatConnectionErrorMessage('auth_failed', { profile });
    expect(msg).toContain('username and password');
    expect(msg).toContain('Living Room MiSTer');
  });

  it('mentions /media/fat/games for not_a_mister', () => {
    const msg = formatConnectionErrorMessage('not_a_mister', { profile });
    expect(msg).toContain('/media/fat/games');
    expect(msg).toContain('192.168.1.50');
  });

  it('appends the underlying message for unknown', () => {
    const msg = formatConnectionErrorMessage('unknown', {
      profile,
      underlyingMessage: 'Read ECONNRESET',
    });
    expect(msg).toContain('Living Room MiSTer');
    expect(msg).toContain('Read ECONNRESET');
  });

  it('omits the trailing dot-period when underlying message is empty', () => {
    const msg = formatConnectionErrorMessage('unknown', {
      profile,
      underlyingMessage: '',
    });
    expect(msg).toBe(`Couldn't connect to ${profile.name}.`);
  });

  it('handles missing underlying message gracefully (still mentions profile)', () => {
    const msg = formatConnectionErrorMessage('unknown', { profile });
    expect(msg).toBe(`Couldn't connect to ${profile.name}.`);
  });
});

describe('formatConnectingMessage', () => {
  it('returns null inside the reveal-delay window', () => {
    expect(formatConnectingMessage(0)).toBeNull();
    expect(formatConnectingMessage(1_500)).toBeNull();
    expect(formatConnectingMessage(CONNECTING_REVEAL_MS - 1)).toBeNull();
  });

  it('shows seconds-counted message between reveal and still-connecting', () => {
    expect(formatConnectingMessage(CONNECTING_REVEAL_MS)).toBe(
      'Connecting… (3s)',
    );
    expect(formatConnectingMessage(5_000)).toBe('Connecting… (5s)');
    expect(formatConnectingMessage(STILL_CONNECTING_MS - 1)).toBe(
      'Connecting… (7s)',
    );
  });

  it('softens the message after the still-connecting threshold', () => {
    expect(formatConnectingMessage(STILL_CONNECTING_MS)).toMatch(
      /Still connecting/,
    );
    expect(formatConnectingMessage(15_000)).toMatch(/Still connecting/);
    expect(formatConnectingMessage(60_000)).toMatch(/may be slow/);
  });

  it('uses floor seconds (3 999ms still reads as 3s)', () => {
    expect(formatConnectingMessage(3_999)).toBe('Connecting… (3s)');
  });
});

describe('backoffDelayMs', () => {
  it('matches the 1s / 3s / 8s schedule for attempts 0..2', () => {
    expect(backoffDelayMs(0)).toBe(1_000);
    expect(backoffDelayMs(1)).toBe(3_000);
    expect(backoffDelayMs(2)).toBe(8_000);
  });

  it('returns undefined for out-of-range attempts (signals "stop")', () => {
    expect(backoffDelayMs(3)).toBeUndefined();
    expect(backoffDelayMs(99)).toBeUndefined();
    expect(backoffDelayMs(-1)).toBeUndefined();
  });

  it('exposes the schedule as RECONNECT_BACKOFF_MS for direct iteration', () => {
    expect([...RECONNECT_BACKOFF_MS]).toEqual([1_000, 3_000, 8_000]);
  });
});
