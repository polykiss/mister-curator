import { useEffect, useState } from 'react';

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
    void window.mister
      .getBoxArtBytes(url)
      .then((bytes) => {
        if (cancelled || bytes === null || bytes.byteLength === 0) {
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
        setObjectUrl(createdUrl);
      })
      .catch(() => {
        if (cancelled) return;
        setObjectUrl(null);
      });
    return () => {
      cancelled = true;
      if (createdUrl !== null) URL.revokeObjectURL(createdUrl);
    };
  }, [url]);

  return objectUrl;
}
