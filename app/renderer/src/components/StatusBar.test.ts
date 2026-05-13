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

describe('idleMessageFor — connect-phase surfacing (feat/connect-progress-ui)', () => {
  it('renders the phase label + elapsed seconds during connecting once past the reveal delay', () => {
    // formatConnectingMessage returns null while elapsed < 3s (the
    // reveal delay); the footer falls back to the generic copy
    // there. Past 3s it returns the phase-aware string.
    expect(
      idleMessageFor('connecting', {
        lostConnection: false,
        autoRetry: null,
        autoRetryFailed: false,
        connectingElapsedMs: 4_500,
        connectingPhase: 'priming',
      }),
    ).toBe('Reading device state… (4s)');
    expect(
      idleMessageFor('connecting', {
        lostConnection: false,
        autoRetry: null,
        autoRetryFailed: false,
        connectingElapsedMs: 5_000,
        connectingPhase: 'arcade-parse',
      }),
    ).toBe('Parsing arcade metadata… (5s)');
  });

  it('falls back to the generic "Connecting…" string during the reveal delay (< 3s)', () => {
    // Pre-reveal formatConnectingMessage returns null; the footer
    // still needs to say SOMETHING, so the connecting branch
    // returns the static fallback string. Without this fallback the
    // footer would render an empty line for the first 3 seconds.
    expect(
      idleMessageFor('connecting', {
        lostConnection: false,
        autoRetry: null,
        autoRetryFailed: false,
        connectingElapsedMs: 1_500,
        connectingPhase: 'transport',
      }),
    ).toBe('Connecting…');
  });

  it('preserves pre-feat-connect-progress-ui call shape (no resilience args = generic copy)', () => {
    // Existing callsites passed no resilience second-arg at all and
    // got 'Connecting…'. That behaviour stays — the new fields
    // are optional, default to elapsed=0 / phase=null which falls
    // through the reveal-delay branch.
    expect(idleMessageFor('connecting')).toBe('Connecting…');
  });

  it('escalation message past 8s overrides the phase label (your-MiSTer-may-be-slow framing)', () => {
    expect(
      idleMessageFor('connecting', {
        lostConnection: false,
        autoRetry: null,
        autoRetryFailed: false,
        connectingElapsedMs: 9_000,
        connectingPhase: 'cores-walk',
      }),
    ).toBe('Still connecting… your MiSTer may be slow to respond.');
  });
});

describe('autoScrapeMessageFor — discovering state (feat/connect-progress-ui)', () => {
  it('formats discovering with X/Y core position so the per-core walk shows even on zero-ROM cores', () => {
    // The user's "60+ silent SSH probes" observation: most cores
    // have zero ROMs, so the engine flashes through them with no
    // `active` event (total=0 short-circuits the scrape loop). The
    // discovering state surfaces the queue walk in real time.
    expect(
      autoScrapeMessageFor(
        {
          state: 'discovering',
          coreId: 'PMD85',
          coreLabel: 'PMD85',
          completedCoreIds: ['SNES', 'NES', 'Genesis', 'Atari2600'],
          remainingCount: 22,
        },
        'connected',
      ),
    ).toBe('Probing ROM directories: 5/27 · PMD85');
  });

  it('returns null for discovering when the connection is not steady-state connected', () => {
    expect(
      autoScrapeMessageFor(
        {
          state: 'discovering',
          coreId: 'PMD85',
          coreLabel: 'PMD85',
          completedCoreIds: [],
          remainingCount: 0,
        },
        'connecting',
      ),
    ).toBeNull();
  });
});
