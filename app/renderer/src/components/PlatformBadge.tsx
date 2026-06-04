import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Skeleton } from '@app/renderer/src/components/ui/skeleton';

interface Props {
  /** System logo URL (catalog `logoUrl`), or null when the core has none. */
  readonly url: string | null;
  /** Core display name — rendered as a wordmark when there's no logo. */
  readonly name: string;
}

/**
 * PlatformBadge — the consistent leading identity slot for a cores-list
 * row. A FIXED 104×40 box; the logo is normalized to a 26px cap-height so
 * SEGA / GBA / MSX / Neo-Geo / NES all sit at the same visual size and
 * baseline (replaces the raw native-size `CoreLogo` image in the sidebar).
 *
 * Logo-less cores (Amiga, Arcade, DOS Games) render their NAME as a
 * wordmark in the same box, so every row reads as one consistent type —
 * never a bare-text row next to logo rows. See SYSTEM.md §5 "Core identity
 * cell" + §6a "PlatformBadge".
 *
 * Keeps the object-URL fetch/cleanup contract from the original CoreLogo.
 */
export function PlatformBadge({ url, name }: Props): JSX.Element {
  const objectUrlRef = useRef<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current !== null) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (url === null) {
      setObjectUrl(null);
      return;
    }
    let cancelled = false;
    void window.mister.getSystemLogoBytes(url).then((bytes) => {
      if (cancelled || bytes === null) return;
      const blob = new Blob([new Uint8Array(bytes)]);
      if (objectUrlRef.current !== null) URL.revokeObjectURL(objectUrlRef.current);
      const created = URL.createObjectURL(blob);
      objectUrlRef.current = created;
      setObjectUrl(created);
    });
    return () => { cancelled = true; };
  }, [url]);

  // Logo-less: name as a wordmark in the badge box (one consistent row type).
  // D25: smaller text for name-fallback rows so they don't visually
  // dominate next to logo rows at the same row height.
  if (url === null) {
    return (
      <span className="flex h-10 w-[104px] shrink-0 items-center text-body-sm font-semibold leading-tight tracking-[-0.01em] text-fg">
        {name}
      </span>
    );
  }

  if (objectUrl === null) {
    return <Skeleton className="h-10 w-[104px] shrink-0 rounded" />;
  }

  // Fixed box; logo normalized to 32px cap-height (D25: slightly larger
  // than the original 26px so logos read more clearly in the sidebar row).
  // `invert` renders black-on-transparent monochrome logos white on dark.
  return (
    <span className="flex h-10 w-[104px] shrink-0 items-center overflow-hidden">
      <img
        src={objectUrl}
        alt={name}
        aria-hidden
        className="h-[32px] w-auto max-w-[104px] object-contain object-left invert"
      />
    </span>
  );
}
