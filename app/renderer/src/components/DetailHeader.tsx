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
  /**
   * Heading size class. Default `text-heading` for the roomy layout.
   * CoreInfo passes `text-body` (smaller per D31).
   */
  readonly titleClassName?: string;
  /** Inline metadata beside the title — CoreInfo passes its badge chips. */
  readonly chips?: ReactNode;
  /** Muted line below the title — RomDetail: publisher · year · genre (not system). */
  readonly subtitle?: ReactNode;
  /**
   * D26/D32: compact layout for RomDetailDialog.
   * Logo left; stacked text right: [title (bold body)] / [systemName] / [subtitle].
   */
  readonly compact?: boolean;
  /**
   * D32: system name shown as the second stacked line in compact mode
   * (e.g. "Game Boy Advance"). Separate from subtitle so it renders
   * on its own line before publisher · year · genre.
   */
  readonly systemName?: string;
}

/**
 * Shared detail-dialog header used by BOTH CoreInfoDialog and
 * RomDetailDialog so the two stay in sync.
 *
 * Two variants:
 *
 *   compact=false (CoreInfoDialog — default):
 *     kicker → [large platform logo, stacked] → title + chips → subtitle
 *     Logo: max-h-[72px]. Roomy padding.
 *
 *   compact=true (RomDetailDialog — D32):
 *     kicker → [logo LEFT | stacked RIGHT: title / systemName / subtitle]
 *     Logo is left-aligned, small (max-h-8). To its right:
 *       line 1: game title (text-body font-bold)
 *       line 2: system name (text-body-sm text-fg-muted)
 *       line 3: publisher · year · genre (text-body-sm text-fg-muted)
 *
 * Owns the logo blob-fetch + objectURL lifecycle.
 */
export function DetailHeader({
  kicker,
  logoUrl,
  logoAlt,
  title,
  titleClassName = 'text-heading',
  chips,
  subtitle,
  compact = false,
  systemName,
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

  if (compact) {
    // D32 compact: logo on the left; stacked text block on the right.
    // Three lines: game title (bold body) / system name / pub·year·genre.
    return (
      <div className="px-5 pb-3 pt-4">
        <div className="mb-2 text-caption font-bold uppercase tracking-[0.19em] text-fg-muted">
          {kicker}
        </div>
        <div className="flex min-w-0 items-start gap-3">
          {logoUrl !== null ? (
            <div className="mt-0.5 shrink-0">
              {objectUrl !== null ? (
                <img
                  src={objectUrl}
                  alt={logoAlt}
                  className="max-h-8 max-w-[80px] object-contain object-left invert"
                />
              ) : (
                <Skeleton className="h-8 w-[64px]" />
              )}
            </div>
          ) : null}
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="min-w-0 break-words text-body font-bold tracking-[-0.01em] text-fg">
              {title}
            </h2>
            {systemName !== undefined && systemName !== '' ? (
              <span className="truncate text-body-sm text-fg-muted">{systemName}</span>
            ) : null}
            {subtitle !== undefined && subtitle !== null ? (
              <p className="break-words text-body-sm text-fg-muted">{subtitle}</p>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // Default (roomy) layout — CoreInfoDialog.
  return (
    <div className="px-7 pb-5 pt-6">
      <div className="mb-3 text-caption font-bold uppercase tracking-[0.19em] text-fg-muted">
        {kicker}
      </div>

      {logoUrl !== null ? (
        <div className="mb-3.5 flex h-[72px] items-center">
          {objectUrl !== null ? (
            <img
              src={objectUrl}
              alt={logoAlt}
              className="max-h-[72px] max-w-[240px] object-contain object-left invert"
            />
          ) : (
            <Skeleton className="h-[72px] w-[180px]" />
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
