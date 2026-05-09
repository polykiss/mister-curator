import { useEffect, useState } from 'react';

import type { RomMetadata } from '@shared/metadata-types';
import type { Rom } from '@shared/types';

/**
 * Per-row metadata fetch. Calls `getRomMetadata(coreId, path)` on mount
 * and re-fetches when `(coreId, path)` change. The main process gates
 * concurrent fetches per-hash, dedupes downloads, and serves from the
 * local cache on warm hits, so this hook can fire freely from many
 * rows without coordinating in the renderer.
 *
 * Three states:
 *   - 'loading': fetch in flight; no metadata yet.
 *   - 'loaded': IPC resolved with a non-null record (SS or OpenVGDB).
 *   - 'unmatched': IPC resolved with null (no match in any source, or
 *     pre-conditions missing — e.g., no active session).
 *
 * Folder-kind ROMs (`folder-atomic` / `folder-container`) skip the
 * fetch entirely — they aren't hashed by the metadata pipeline. They
 * resolve to 'unmatched' immediately so the row falls back to its
 * filename without any IPC round-trip.
 */
export type RomMetadataStatus = 'loading' | 'loaded' | 'unmatched';

export interface RomMetadataResult {
  readonly status: RomMetadataStatus;
  readonly metadata: RomMetadata | null;
}

export function useRomMetadata(rom: Rom): RomMetadataResult {
  const [result, setResult] = useState<RomMetadataResult>(() =>
    rom.kind === 'file'
      ? { status: 'loading', metadata: null }
      : { status: 'unmatched', metadata: null },
  );

  useEffect(() => {
    if (rom.kind !== 'file') {
      setResult({ status: 'unmatched', metadata: null });
      return;
    }
    setResult({ status: 'loading', metadata: null });
    let cancelled = false;
    void window.mister
      .getRomMetadata(rom.coreId, rom.path)
      .then((meta) => {
        if (cancelled) return;
        if (meta === null || meta.source === 'none') {
          setResult({ status: 'unmatched', metadata: null });
        } else {
          setResult({ status: 'loaded', metadata: meta });
        }
      })
      .catch(() => {
        if (cancelled) return;
        // IPC failure (e.g., disconnected mid-fetch). Treat as
        // unmatched — the row will show filename + dashes, which is
        // the right copy for "we don't know yet".
        setResult({ status: 'unmatched', metadata: null });
      });
    return () => {
      cancelled = true;
    };
  }, [rom.coreId, rom.path, rom.kind]);

  return result;
}
