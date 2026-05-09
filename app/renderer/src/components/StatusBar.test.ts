import { describe, expect, it } from 'vitest';

import { idleMessageFor } from '@app/renderer/src/components/StatusBar';

/**
 * `idleMessageFor` is the pure copy-picker for the footer-left
 * text. PR-A item 7 dropped the host string from every branch:
 * the top header carries the address and the right-pill carries
 * the steady-state. The footer-left now ONLY surfaces transient
 * transitions that add new information.
 */
describe('idleMessageFor — base ConnectionStatus copy (PR-A item 7)', () => {
  it('returns empty string for the steady-state connected case', () => {
    // The right-pill says "connected"; the footer-left adds
    // nothing. Keeps the chrome clean when the app is idle and
    // happy.
    expect(idleMessageFor('connected')).toBe('');
  });

  it('returns transient-state copy without host', () => {
    expect(idleMessageFor('connecting')).toBe('Connecting…');
    expect(idleMessageFor('error')).toBe('Connection error');
    expect(idleMessageFor('disconnected')).toBe('Disconnected');
  });
});

describe('idleMessageFor — resilience signals', () => {
  it('autoRetry overrides everything else with attempt-count copy (no host)', () => {
    expect(
      idleMessageFor('disconnected', {
        lostConnection: true,
        autoRetry: { attempt: 2, totalAttempts: 3 },
        autoRetryFailed: false,
      }),
    ).toBe('Reconnecting (2 of 3)…');
  });

  it('lostConnection without an active retry reads as "retrying" (no host)', () => {
    // Brief gap between `disconnected-unexpected` and the first
    // `auto-retry-attempt` event — the renderer paints this hint so
    // the user sees we noticed.
    expect(
      idleMessageFor('disconnected', {
        lostConnection: true,
        autoRetry: null,
        autoRetryFailed: false,
      }),
    ).toBe('Connection lost, retrying…');
  });

  it('autoRetryFailed surfaces the terminal copy with action prompt (no host)', () => {
    expect(
      idleMessageFor('disconnected', {
        lostConnection: true,
        autoRetry: null,
        autoRetryFailed: true,
      }),
    ).toBe('Connection lost. Reconnect or disconnect.');
  });

  it('connected with no resilience signals returns empty string', () => {
    expect(
      idleMessageFor('connected', {
        lostConnection: false,
        autoRetry: null,
        autoRetryFailed: false,
      }),
    ).toBe('');
  });
});
