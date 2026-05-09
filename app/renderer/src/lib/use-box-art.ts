import { useEffect, useState } from 'react';

import { diagLog } from '@shared/diag-log';

/**
 * Fetches box-art bytes via the main-process image cache and exposes
 * a Blob objectURL the renderer can hand to `<img src>`. The cache
 * downloads lazily on first request; warm hits are local fs reads.
 *
 * `url` is the upstream CDN URL (ScreenScraper or libretro-thumbnails).
 * Pass `null` to indicate "no art available" — the hook skips the
 * fetch and returns null. Changing `url` revokes the previous
 * objectURL before issuing the next fetch.
 *
 * Lifecycle:
 *   - On mount / url change: fetch bytes, build Blob, create
 *     objectURL, return.
 *   - On unmount / url change: revoke the previous objectURL so the
 *     browser can release the underlying memory. Critical when many
 *     rows scroll in and out of view.
 */
export function useBoxArt(url: string | null): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (url === null || url.length === 0) {
      setObjectUrl(null);
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    diagLog('info', 'boxart', '→', 'use-hook fetching', {
      // No url field — main-side logs the redacted url and we want
      // to keep this side free of unredacted SS creds.
    });
    void window.mister
      .getBoxArtBytes(url)
      .then((bytes) => {
        if (cancelled) return;
        if (bytes === null) {
          diagLog('warn', 'boxart', '✗', 'use-hook null-bytes');
          setObjectUrl(null);
          return;
        }
        if (bytes.byteLength === 0) {
          diagLog('warn', 'boxart', '✗', 'use-hook empty-bytes');
          setObjectUrl(null);
          return;
        }
        // `bytes` is typed `Uint8Array<ArrayBufferLike>` after the
        // structured-clone trip, but Blob's constructor in TS lib.dom
        // narrows BlobPart's TypedArray to `ArrayBuffer`-backed only.
        // Copy into a fresh Uint8Array to satisfy the type without
        // changing semantics — Blob's binary input handling is the
        // same either way.
        const blob = new Blob([new Uint8Array(bytes)]);
        createdUrl = URL.createObjectURL(blob);
        diagLog('info', 'boxart', '←', 'use-hook ready', {
          bytes: bytes.byteLength,
        });
        setObjectUrl(createdUrl);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        diagLog('error', 'boxart', '✗', 'use-hook ipc-error', {
          err: err instanceof Error ? err.message : String(err),
        });
        setObjectUrl(null);
      });
    return () => {
      cancelled = true;
      if (createdUrl !== null) URL.revokeObjectURL(createdUrl);
    };
  }, [url]);

  return objectUrl;
}
