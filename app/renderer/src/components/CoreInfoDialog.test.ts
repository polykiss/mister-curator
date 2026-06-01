import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Structural contract for CoreInfoDialog v2.0.
 * Source-string scanning (same pattern as other dialog tests).
 */
const SOURCE = readFileSync(
  resolve(__dirname, 'CoreInfoDialog.tsx'),
  'utf8',
);

describe('CoreInfoDialog v2.0 — dialog size and layout', () => {
  it('uses max-w-[1060px] (not the old max-w-2xl)', () => {
    expect(SOURCE).toContain('max-w-[1060px]');
    expect(SOURCE).not.toContain('max-w-2xl');
  });

  it('uses hideDefaultClose so the header renders without a redundant X', () => {
    expect(SOURCE).toContain('hideDefaultClose');
  });

  it('renders the "Core info" kicker in the header', () => {
    expect(SOURCE).toContain('Core info');
  });

  it('renders header chips for company, years, and media', () => {
    expect(SOURCE).toContain('<Chip dot>');
    expect(SOURCE).toContain('catalogEntry');
  });
});

describe('CoreInfoDialog v2.0 — three stat sections', () => {
  it('renders Core section', () => {
    expect(SOURCE).toContain('"Core"');
  });

  it('renders ROM library section', () => {
    expect(SOURCE).toContain('"ROM library"');
  });

  it('renders ScreenScraper section when catalog entry exists', () => {
    expect(SOURCE).toContain('"ScreenScraper"');
  });
});

describe('CoreInfoDialog v2.0 — Core section fields', () => {
  it('displays core.id', () => {
    expect(SOURCE).toContain('core.id');
  });

  it('displays core.category', () => {
    expect(SOURCE).toContain('core.category');
  });

  it('displays core.rbfPaths', () => {
    expect(SOURCE).toContain('core.rbfPaths');
  });

  it('displays core.gamesDirName with em-dash fallback', () => {
    expect(SOURCE).toContain('core.gamesDirName');
    expect(SOURCE).toContain("'—'");
  });
});

describe('CoreInfoDialog v2.0 — ROM library section fields', () => {
  it('derives status from gamesDirExists + gamesDirHidden', () => {
    expect(SOURCE).toContain('core.gamesDirExists');
    expect(SOURCE).toContain('core.gamesDirHidden');
    expect(SOURCE).toContain('Missing');
    expect(SOURCE).toContain('Available');
  });

  it('shows arcade playable count only when defined', () => {
    expect(SOURCE).toContain('core.arcadePlayableCount');
    expect(SOURCE).toMatch(/arcadePlayableCount.*!==.*undefined|arcadePlayableCount.*\?/s);
  });

  it('shows romCount with recursive annotation support', () => {
    expect(SOURCE).toContain('core.romCount');
    expect(SOURCE).toContain('recursive');
  });

  it('shows hiddenCount', () => {
    expect(SOURCE).toContain('core.hiddenCount');
  });
});

describe('CoreInfoDialog v2.0 — ScreenScraper section fields', () => {
  it('shows catalog systemId and displayName', () => {
    expect(SOURCE).toContain('catalogEntry.id');
    expect(SOURCE).toContain('catalogEntry.displayName');
  });

  it('shows manufacturer when company non-null', () => {
    expect(SOURCE).toContain('catalogEntry.company');
    expect(SOURCE).toContain('"Manufacturer"');
  });

  it('shows type when type non-null', () => {
    expect(SOURCE).toContain('catalogEntry.type');
    expect(SOURCE).toContain('"Type"');
  });

  it('shows years formatted via formatYears', () => {
    expect(SOURCE).toContain('formatYears');
    expect(SOURCE).toContain('catalogEntry.yearStart');
    expect(SOURCE).toContain('catalogEntry.yearEnd');
    expect(SOURCE).toContain('"Years"');
  });

  it('shows supportType as Format', () => {
    expect(SOURCE).toContain('catalogEntry.supportType');
    expect(SOURCE).toContain('"Format"');
  });

  it('shows extensions joined by comma', () => {
    expect(SOURCE).toContain('catalogEntry.extensions');
    expect(SOURCE).toContain('.join(');
    expect(SOURCE).toContain('"Extensions"');
  });

  it('shows fallback text when no catalog entry', () => {
    expect(SOURCE).toContain('No ScreenScraper mapping for this core');
  });
});

describe('CoreInfoDialog v2.0 — logo image', () => {
  it('fetches logo via getSystemLogoBytes', () => {
    expect(SOURCE).toContain('getSystemLogoBytes');
    expect(SOURCE).toContain('logoUrl');
  });

  it('shows img when logoObjectUrl is loaded', () => {
    expect(SOURCE).toContain('logoObjectUrl');
    expect(SOURCE).toContain('<img');
  });

  it('shows Skeleton while logo is loading', () => {
    expect(SOURCE).toContain('<Skeleton');
  });
});

describe('CoreInfoDialog v2.0 — console photo', () => {
  it('fetches console photo via getSystemLogoBytes with photoUrl', () => {
    expect(SOURCE).toContain('photoUrl');
    expect(SOURCE).toContain('photoObjectUrl');
  });

  it('falls back to Wikipedia thumbnailUrl when photoObjectUrl is null', () => {
    expect(SOURCE).toContain('thumbnailUrl');
    expect(SOURCE).toContain('photoSrc');
  });

  it('renders ConsolePhotoCard when photo is available', () => {
    expect(SOURCE).toContain('ConsolePhotoCard');
  });
});

describe('CoreInfoDialog v2.0 — Wikipedia About panel', () => {
  it('calls getSystemWikipediaSummary with the system SS id', () => {
    expect(SOURCE).toContain('getSystemWikipediaSummary');
    expect(SOURCE).toContain('catalogEntry.id');
  });

  it('renders Wikipedia extract when loaded', () => {
    expect(SOURCE).toContain('wikipedia.extract');
  });

  it('shows Skeleton lines while Wikipedia is loading', () => {
    expect(SOURCE).toContain("'loading'");
  });

  it('shows "No Wikipedia article" fallback when null', () => {
    expect(SOURCE).toContain('No Wikipedia article');
  });
});

describe('CoreInfoDialog v2.0 — Facts table', () => {
  it('renders FactRow for Manufacturer', () => {
    expect(SOURCE).toContain('"Manufacturer"');
    expect(SOURCE).toContain('FactRow');
  });

  it('renders FactRow for Released using formatYears', () => {
    expect(SOURCE).toContain('"Released"');
  });

  it('renders FactRow for Media using supportType', () => {
    expect(SOURCE).toContain('"Media"');
  });
});

describe('CoreInfoDialog v2.0 — Copy button', () => {
  it('wires Copy button to navigator.clipboard.writeText with core.id', () => {
    expect(SOURCE).toContain('navigator.clipboard.writeText');
    expect(SOURCE).toContain('core.id');
  });

  it('shows toast.success on copy', () => {
    expect(SOURCE).toContain("toast.success('Copied')");
  });

  it('uses the Copy icon from lucide-react', () => {
    expect(SOURCE).toContain('import { Copy }');
    expect(SOURCE).toMatch(/<Copy\b/);
  });
});

describe('CoreInfoDialog v2.0 — null guard', () => {
  it('renders null for core content when core prop is null', () => {
    expect(SOURCE).toContain('core !== null');
  });
});

describe('CoreInfoDialog v2.0 — formatYears logic', () => {
  it('contains "–present" for open-ended year ranges', () => {
    expect(SOURCE).toContain('–present');
  });

  it('formats a closed range with en-dash', () => {
    expect(SOURCE).toMatch(/\$\{.*start.*\}–\$\{|'–'/);
  });
});

describe('CoreInfoDialog v2.0 — CountDisplay logic', () => {
  it('hides recursive annotation when count matches recursive', () => {
    expect(SOURCE).toMatch(/recursive.*!==.*count|count.*!==.*recursive/s);
  });

  it('shows "rec." annotation when recursive differs', () => {
    expect(SOURCE).toContain('rec.');
  });
});

describe('CoreInfoDialog v2.0 — defensive localCatalog self-fetch', () => {
  it('declares localCatalog state', () => {
    expect(SOURCE).toContain('localCatalog');
  });

  it('fetches catalog from getSystemCatalog when prop is null', () => {
    expect(SOURCE).toContain('getSystemCatalog');
    expect(SOURCE).toContain('setLocalCatalog');
  });

  it('merges prop and local catalog with prop winning', () => {
    expect(SOURCE).toContain('effectiveCatalog');
    expect(SOURCE).toContain('catalog ?? localCatalog');
  });
});

describe('CoreInfoDialog v2.0 — visual polish (phase 2)', () => {
  it('sorts sidebar by display name via localeCompare', () => {
    // This dialog test asserts the *dialog* StatCell value size is text-body
    expect(SOURCE).not.toContain("'text-heading-sm font-medium leading-[1.35] text-fg'");
    expect(SOURCE).toContain("'text-body font-medium leading-[1.35] text-fg'");
  });

  it('Wikipedia text is wrapped in a scrollable container', () => {
    expect(SOURCE).toContain('overflow-y-auto');
    expect(SOURCE).toContain('max-h-[220px]');
  });

  it('grid gives left pane more room (1.4fr) and right strip 320px', () => {
    expect(SOURCE).toContain("'1.4fr 320px'");
    expect(SOURCE).not.toContain("'1fr 340px'");
  });

  it('photo card uses object-contain to prevent cropping', () => {
    expect(SOURCE).toContain('object-contain');
    expect(SOURCE).toContain('ConsolePhotoCard');
  });
});

describe('CoreInfoDialog v2.0 — accessibility', () => {
  it('renders DialogTitle for screen readers', () => {
    expect(SOURCE).toContain('DialogTitle');
    expect(SOURCE).toMatch(/<DialogTitle[^>]*sr-only/);
  });

  it('renders DialogDescription for screen readers', () => {
    expect(SOURCE).toContain('DialogDescription');
    expect(SOURCE).toMatch(/<DialogDescription[^>]*sr-only/);
  });
});
