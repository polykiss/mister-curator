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
  // feat/auto-scrape-persistence: format extended to "<label>
  // (<done>/<total>) · <N> done · <M> queued". Tail segments
  // drop when zero so the message stays short on the common case.
  it('renders just the per-core line when nothing else is happening', () => {
    expect(
      autoScrapeMessageFor(
        {
          state: 'active',
          coreId: 'SNES',
          coreLabel: 'SNES',
          done: 234,
          total: 566,
          completedCoreIds: [],
          remainingCount: 0,
        },
        'connected',
      ),
    ).toBe('Scraping SNES (234/566)');
  });

  it('appends "<N> done" when there are completed cores in the session', () => {
    expect(
      autoScrapeMessageFor(
        {
          state: 'active',
          coreId: 'mame',
          coreLabel: 'Arcade',
          done: 123,
          total: 680,
          completedCoreIds: ['NES', 'SNES', 'GBA'],
          remainingCount: 0,
        },
        'connected',
      ),
    ).toBe('Scraping Arcade (123/680) · 3 done');
  });

  it('appends "<N> done · <M> queued" when both are non-zero', () => {
    expect(
      autoScrapeMessageFor(
        {
          state: 'active',
          coreId: 'mame',
          coreLabel: 'Arcade',
          done: 123,
          total: 680,
          completedCoreIds: ['NES', 'SNES', 'GBA'],
          remainingCount: 5,
        },
        'connected',
      ),
    ).toBe('Scraping Arcade (123/680) · 3 done · 5 queued');
  });

  it('appends only "<M> queued" when no cores have completed yet', () => {
    expect(
      autoScrapeMessageFor(
        {
          state: 'active',
          coreId: 'NES',
          coreLabel: 'NES',
          done: 5,
          total: 25,
          completedCoreIds: [],
          remainingCount: 12,
        },
        'connected',
      ),
    ).toBe('Scraping NES (5/25) · 12 queued');
  });

  it('uses coreLabel verbatim — engine pre-resolves mame → "Arcade"', () => {
    expect(
      autoScrapeMessageFor(
        {
          state: 'active',
          coreId: 'mame',
          coreLabel: 'Arcade',
          done: 650,
          total: 650,
          completedCoreIds: [],
          remainingCount: 0,
        },
        'connected',
      ),
    ).toBe('Scraping Arcade (650/650)');
  });

  it('returns null when the engine is idle (caller falls through to idleMessageFor)', () => {
    expect(
      autoScrapeMessageFor(
        { state: 'idle', completedCoreIds: [] },
        'connected',
      ),
    ).toBeNull();
  });

  it('returns null when the connection is not steady-state connected', () => {
    const active = {
      state: 'active' as const,
      coreId: 'NES',
      coreLabel: 'NES',
      done: 5,
      total: 25,
      completedCoreIds: [],
      remainingCount: 0,
    };
    expect(autoScrapeMessageFor(active, 'disconnected')).toBeNull();
    expect(autoScrapeMessageFor(active, 'connecting')).toBeNull();
    expect(autoScrapeMessageFor(active, 'error')).toBeNull();
  });

  it('is integer-only — no padding, no percentage, no "ROMs" word', () => {
    const message = autoScrapeMessageFor(
      {
        state: 'active',
        coreId: 'N64',
        coreLabel: 'N64',
        done: 12,
        total: 79,
        completedCoreIds: [],
        remainingCount: 0,
      },
      'connected',
    );
    expect(message).toBe('Scraping N64 (12/79)');
    expect(message).not.toContain('ROMs');
    expect(message).not.toContain('%');
  });
});
