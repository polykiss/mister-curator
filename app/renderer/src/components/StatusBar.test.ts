import { describe, expect, it } from 'vitest';

import {
  autoScrapeMessageFor,
  idleMessageFor,
} from '@app/renderer/src/components/StatusBar';

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

describe('autoScrapeMessageFor — PR-C (PR #26) footer-left progress', () => {
  it('renders "<coreLabel> · <done>/<total>" while the engine is active', () => {
    expect(
      autoScrapeMessageFor(
        { state: 'active', coreId: 'SNES', coreLabel: 'SNES', done: 234, total: 566 },
        'connected',
      ),
    ).toBe('SNES · 234/566');
  });

  it('uses coreLabel verbatim — engine pre-resolves mame → "Arcade"', () => {
    expect(
      autoScrapeMessageFor(
        { state: 'active', coreId: 'mame', coreLabel: 'Arcade', done: 650, total: 650 },
        'connected',
      ),
    ).toBe('Arcade · 650/650');
  });

  it('returns null when the engine is idle (caller falls through to idleMessageFor)', () => {
    expect(autoScrapeMessageFor({ state: 'idle' }, 'connected')).toBeNull();
  });

  it('returns null when the connection is not steady-state connected', () => {
    // The engine pauses on disconnect, but a stale event could still
    // be in the renderer's state — gating on status keeps the footer
    // honest even before the pause event has propagated.
    expect(
      autoScrapeMessageFor(
        { state: 'active', coreId: 'NES', coreLabel: 'NES', done: 5, total: 25 },
        'disconnected',
      ),
    ).toBeNull();
    expect(
      autoScrapeMessageFor(
        { state: 'active', coreId: 'NES', coreLabel: 'NES', done: 5, total: 25 },
        'connecting',
      ),
    ).toBeNull();
    expect(
      autoScrapeMessageFor(
        { state: 'active', coreId: 'NES', coreLabel: 'NES', done: 5, total: 25 },
        'error',
      ),
    ).toBeNull();
  });

  it('is integer-only — no padding, no percentage, no "ROMs" word', () => {
    // The PR-C spec asks for the bare numbers; the format should be
    // stable across cores. Pin against accidental "5/25 ROMs" or
    // "  5/ 25 (20%)" extensions.
    const message = autoScrapeMessageFor(
      { state: 'active', coreId: 'N64', coreLabel: 'N64', done: 12, total: 79 },
      'connected',
    );
    expect(message).toBe('N64 · 12/79');
    expect(message).not.toContain('ROMs');
    expect(message).not.toContain('%');
  });
});
