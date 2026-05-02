import { MisterConnectionError } from '@shared/types';
import type { ConnectionErrorCode, MisterProfile } from '@shared/types';

/**
 * Maps a thrown error from an IPC call to a short, human-readable string
 * suitable for a toast or inline error message. Never returns a stack trace.
 */
export function friendlyConnectionError(err: unknown, profile?: MisterProfile): string {
  if (err instanceof MisterConnectionError) {
    return friendlyForCode(err.code, err.message, profile);
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'Unexpected error.';
}

function friendlyForCode(
  code: ConnectionErrorCode,
  fallbackMessage: string,
  profile: MisterProfile | undefined,
): string {
  const host = profile?.host ?? 'the MiSTer';
  switch (code) {
    case 'unreachable':
      return `Could not reach ${host}. Is it powered on and on the same network?`;
    case 'auth_failed':
      return 'Login failed. Check your username and password or key.';
    case 'not_a_mister':
      return 'Connected, but /media/fat/games is missing. Is this a MiSTer?';
    case 'unknown':
      return fallbackMessage;
  }
}

/**
 * Formats a byte count as a human-readable string with appropriate unit.
 * Uses 1024-based units (KB = 1024 B). Examples:
 *   0          → "0 B"
 *   512        → "512 B"
 *   2048       → "2.0 KB"
 *   1_572_864  → "1.5 MB"
 *   2_147_483_648 → "2.0 GB"
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${fixed} ${units[unitIndex] ?? 'B'}`;
}

/**
 * Strip a leading dot if present. Used to derive the display name from a raw
 * filename when the renderer needs to render a Rom that came from somewhere
 * other than the IMisterClient (which already populates displayName).
 */
export function stripLeadingDot(filename: string): string {
  return filename.startsWith('.') ? filename.slice(1) : filename;
}
