/**
 * ScreenScraper returns several fields in French. This module normalises
 * them to English at display time, preserving the raw values in the
 * catalog for source attribution and future locale support.
 */

const SUPPORT_TYPE_MAP: Record<string, string> = {
  'bluray': 'Blu-ray',
  'carte': 'Card',
  'cartouche': 'Cartridge',
  'cartouche-cd': 'Cartridge / CD',
  'cartouche-download': 'Cartridge / Download',
  'cartouche-k7': 'Cartridge / Cassette',
  'cartouche-k7-disquette': 'Cartridge / Cassette / Floppy',
  'cd': 'CD-ROM',
  'cd-disquette': 'CD / Floppy',
  'disquette': 'Floppy Disk',
  'download': 'Download',
  'hardware': 'Hardware',
  'k7': 'Cassette',
  'k7-disquette': 'Cassette / Floppy',
  'non-applicable': 'N/A',
  'pcb': 'PCB',
  'smc': 'SMC',
  'videotape': 'VHS / Laserdisc',
  'web': 'Web',
};

// System type values are mixed-case in SS data (e.g. "Console Portable"),
// so the lookup key is the raw value, not lowercased.
const SYSTEM_TYPE_MAP: Record<string, string> = {
  'Accessoire': 'Accessory',
  'Autres': 'Other',
  'Console Portable': 'Handheld',
  'Emulation Arcade': 'Arcade Emulator',
  'Flipper': 'Pinball',
  'Machine Virtuelle': 'Virtual Machine',
  'Ordinateur': 'Computer',
  'Smartphone': 'Mobile',
};

function toSentenceCase(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Normalises a ScreenScraper `supportType` value (e.g. "cartouche",
 * "disquette") to an English display string. Returns null for null input
 * so upstream `!== null` guards continue to suppress empty fields.
 * Unknown values fall back to sentence-case so future French terms
 * surface as readable text until added to the map.
 */
export function formatSupportType(raw: string | null): string | null {
  if (raw === null) return null;
  const key = raw.toLowerCase().trim();
  return SUPPORT_TYPE_MAP[key] ?? toSentenceCase(raw);
}

/**
 * Normalises a ScreenScraper system `type` value (e.g. "Console Portable",
 * "Ordinateur") to an English display string. Unknown values fall back to
 * sentence-case.
 */
export function formatSystemType(raw: string | null): string | null {
  if (raw === null) return null;
  return SYSTEM_TYPE_MAP[raw] ?? toSentenceCase(raw);
}
