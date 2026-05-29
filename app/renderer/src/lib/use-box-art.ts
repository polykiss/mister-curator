import { useEffect, useRef, useState } from 'react';

import { diagLog } from '@shared/diag-log';

/**
 * Fetches box-art bytes via the main-process image cache and exposes
 * a Blob objectURL the renderer can hand to `<img src>`. The cache
 * downloads lazily on first request; warm hits are local fs reads.
 *
 * `url` is the upstream CDN URL (ScreenScraper or libretro-thumbnails).
 * Pass `null` to indicate "no art available" — the hook skips the
 * fetch and returns null. Changing `url` to a different non-null value
 * revokes the previous objectURL before issuing the next fetch.
 *
 * fix/render-cascade-hide-unhide Fix 4: when `url` briefly becomes
 * null (e.g., metadata wipe + repopulate during a hide/unhide cycle)
 * the objectURL is preserved rather than immediately cleared. It is
 * revoked only when a genuinely different URL arrives or the component
 * unmounts. This eliminates the skeleton flash when the same art URL
 * returns after a short null interval.
 *
 * Lifecycle:
 *   - On mount / new url: fetch bytes, build Blob, create objectURL.
 *   - url → same non-null url: re-surface the cached objectURL, no refetch.
 *   - url → null: no-op; preserve existing objectURL across brief clears.
 *   - url → different non-null url: revoke previous, fetch new.
 *   - On unmount: revoke the current objectURL to release memory.
 */
export function useBoxArt(url: string | null): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  // Tracks the last successfully-fetched { url, objectUrl } pair so we
  // can re-surface it when the same URL returns after a null cycle,
  // without issuing a new fetch.
  const lastFetchRef = useRef<{ url: string; objectUrl: string } | null>(null);

  // Revoke on unmount — handles the "row removed from list" case.
  useEffect(() => {
    return () => {
      const last = lastFetchRef.current;
      if (last !== null) {
        URL.revokeObjectURL(last.objectUrl);
        lastFetchRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (url === null || url.length === 0) {
      // Preserve existing objectURL across brief null cycles — return
      // without touching state. The art stays displayed until a different
      // URL arrives or the component unmounts.
      return;
    }

    const last = lastFetchRef.current;

    if (last !== null && last.url === url) {
      // Same URL came back — re-surface the cached objectURL without
      // a new fetch. React bails out of the re-render if the value
      // is already current.
      setObjectUrl(last.objectUrl);
      return;
    }

    // Different (or first) URL — revoke the previous objectURL and
    // issue a fresh fetch. Revocation is explicit here rather than in
    // the cleanup so the URL survives across null cycles.
    if (last !== null) {
      URL.revokeObjectURL(last.objectUrl);
      lastFetchRef.current = null;
    }

    let cancelled = false;
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
        const created = URL.createObjectURL(blob);
        lastFetchRef.current = { url, objectUrl: created };
        diagLog('info', 'boxart', '←', 'use-hook ready', {
          bytes: bytes.byteLength,
        });
        setObjectUrl(created);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        diagLog('error', 'boxart', '✗', 'use-hook ipc-error', {
          err: err instanceof Error ? err.message : String(err),
        });
        setObjectUrl(null);
      });
    return () => {
      // Don't revoke here — preserve the objectURL across null cycles.
      cancelled = true;
    };
  }, [url]);

  return objectUrl;
}
