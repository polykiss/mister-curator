import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Skeleton } from '@app/renderer/src/components/ui/skeleton';

interface DetailHeaderProps {
  /** Tracked-caps kicker, e.g. "Core info" / "ROM detail". */
  readonly kicker: string;
  /** System logo URL (catalog `logoUrl`), or null. Owns its own fetch. */
  readonly logoUrl: string | null;
  /** Alt text for the logo. */
  readonly logoAlt: string;
  /** The heading — system display name (CoreInfo) or game title (RomDetail). */
  readonly title: string;
  /** Heading size class. Default `text-heading` (CoreInfo); RomDetail passes `text-heading-lg`. */
  readonly titleClassName?: string;
  /** Inline metadata beside the title — CoreInfo passes its badge chips. */
  readonly chips?: ReactNode;
  /** Muted line below the title — RomDetail passes "developer · year · genre · system". */
  readonly subtitle?: ReactNode;
}

/**
 * Shared detail-dialog header used by BOTH CoreInfoDialog and
 * RomDetailDialog so the two stay in sync. Layout (top → bottom),
 * matching both detail mockups:
 *
 *   ┌ kicker (tracked caps, fg-muted)
 *   │ [ platform logo ]            ← top-left; monochrome, inverted to white
 *   │ <title>   {chips}            ← heading + optional inline chips (CoreInfo)
 *   └ <subtitle>                   ← optional muted line (RomDetail)
 *
 * When `logoUrl` is null the logo block is omitted and the title line sits
 * directly under the kicker (the system-name / game-title still reads as the
 * heading). Owns the logo blob-fetch + objectURL lifecycle — the same
 * pattern previously duplicated in CoreInfoDialog and PlatformBadge.
 */
export function DetailHeader({
  kicker,
  logoUrl,
  logoAlt,
  title,
  titleClassName = 'text-heading',
  chips,
  subtitle,
}: DetailHeaderProps): JSX.Element {
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
    if (logoUrl === null) { setObjectUrl(null); return; }
    let cancelled = false;
    void window.mister.getSystemLogoBytes(logoUrl).then((bytes) => {
      if (cancelled || bytes === null) return;
      const blob = new Blob([new Uint8Array(bytes)]);
      if (objectUrlRef.current !== null) URL.revokeObjectURL(objectUrlRef.current);
      const created = URL.createObjectURL(blob);
      objectUrlRef.current = created;
      setObjectUrl(created);
    });
    return () => { cancelled = true; };
  }, [logoUrl]);

  return (
    <div className="px-7 pb-5 pt-6">
      <div className="mb-3 text-caption font-bold uppercase tracking-[0.19em] text-fg-muted">
        {kicker}
      </div>

      {logoUrl !== null ? (
        <div className="mb-3.5 flex h-12 items-center">
          {objectUrl !== null ? (
            <img
              src={objectUrl}
              alt={logoAlt}
              className="max-h-12 max-w-[200px] object-contain object-left invert"
            />
          ) : (
            <Skeleton className="h-12 w-[140px]" />
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-[14px]">
        <h2 className={`min-w-0 break-words ${titleClassName} font-bold tracking-[-0.01em] text-fg`}>
          {title}
        </h2>
        {chips}
      </div>

      {subtitle !== undefined && subtitle !== null ? (
        <p className="mt-2 break-words text-body-sm text-fg-muted">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}
