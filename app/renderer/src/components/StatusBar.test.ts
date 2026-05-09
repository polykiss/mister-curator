import { describe, expect, it } from 'vitest';

import { idleMessageFor } from '@app/renderer/src/components/StatusBar';

/**
 * StatusBar's `idleMessageFor` is the pure copy-picker for the
 * left-side text. Round 3 (PR #20) extended it with three
 * resilience signals — `lostConnection`, `autoRetry`, and
 * `autoRetryFailed` — so the user sees a visible "Reconnecting…"
 * during transient drops instead of a flat "Disconnected" while
 * auto-retry is in flight.
 */
describe('idleMessageFor — base ConnectionStatus copy', () => {
  it('returns connected copy with host', () => {
    expect(idleMessageFor('connected', 'mister.local')).toBe(
      'Connected to mister.local',
    );
  });

  it('falls back to host-less copy when host is undefined', () => {
    expect(idleMessageFor('connected', undefined)).toBe('Connected');
    expect(idleMessageFor('disconnected', undefined)).toBe('Disconnected');
  });

  it('returns connecting / error / disconnected copy', () => {
    expect(idleMessageFor('connecting', 'm.lan')).toBe('Connecting to m.lan…');
    expect(idleMessageFor('error', 'm.lan')).toBe('Connection error');
    expect(idleMessageFor('disconnected', 'm.lan')).toBe('Disconnected');
  });
});

describe('idleMessageFor — resilience signals (round 3)', () => {
  it('autoRetry overrides everything else with attempt-count copy', () => {
    expect(
      idleMessageFor('disconnected', 'mister.local', {
        lostConnection: true,
        autoRetry: { attempt: 2, totalAttempts: 3 },
        autoRetryFailed: false,
      }),
    ).toBe('Reconnecting to mister.local (2 of 3)…');
  });

  it('autoRetry without host gracefully omits it', () => {
    expect(
      idleMessageFor('disconnected', undefined, {
        lostConnection: true,
        autoRetry: { attempt: 1, totalAttempts: 3 },
        autoRetryFailed: false,
      }),
    ).toBe('Reconnecting (1 of 3)…');
  });

  it('lostConnection without an active retry reads as "retrying"', () => {
    // Brief gap between `disconnected-unexpected` and the first
    // `auto-retry-attempt` event — the renderer paints this hint so
    // the user sees we noticed.
    expect(
      idleMessageFor('disconnected', 'mister.local', {
        lostConnection: true,
        autoRetry: null,
        autoRetryFailed: false,
      }),
    ).toBe('Connection lost, retrying mister.local…');
  });

  it('autoRetryFailed surfaces the terminal copy with action prompt', () => {
    expect(
      idleMessageFor('disconnected', 'mister.local', {
        lostConnection: true,
        autoRetry: null,
        autoRetryFailed: true,
      }),
    ).toBe('Connection lost to mister.local. Reconnect or disconnect.');
  });

  it('falls through to base copy when no resilience signals are set', () => {
    expect(
      idleMessageFor('connected', 'mister.local', {
        lostConnection: false,
        autoRetry: null,
        autoRetryFailed: false,
      }),
    ).toBe('Connected to mister.local');
  });
});
