import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Skeleton } from '@app/renderer/src/components/ui/skeleton';

interface Props {
  readonly url: string | null;
  /**
   * D7: the core's display name. Used to render the identity when no
   * logo is available — see the two variants in the `url === null`
   * branch below.
   */
  readonly name?: string;
}

/**
 * Core identity logo. D7 (rev. 2): logo if available, otherwise the
 * name carries identity — never a generic gamepad placeholder.
 */
export function CoreLogo({ url }: Props): JSX.Element | null {
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

  // ── D7: no-logo case ──────────────────────────────────────────────
  // VARIANT A (default, minimal): collapse to nothing. CoresPane already
  // renders the core name as a text column beside the logo, so the name
  // carries identity with zero duplication. No gamepad.
  if (url === null) {
    return null;

    // VARIANT B (stronger — the mockup treatment): render the name AS
    // the identity in the logo slot, and suppress the separate name
    // column upstream in CoresPane. Swap the `return null` above for:
    //
    //   return name !== undefined ? (
    //     <span className="flex h-8 shrink-0 items-center text-heading-sm font-semibold text-fg">
    //       {name}
    //     </span>
    //   ) : null;
    //
    // If you adopt Variant B, hide the CoresPane name text when a logo
    // is absent so the name isn't shown twice.
  }

  if (objectUrl === null) {
    return <Skeleton className="h-8 w-8 shrink-0 rounded" />;
  }

  // logo-monochrome variant — invert renders black-on-transparent as
  // white on dark bg. When wheel/color logos are added, gate this
  // conditionally.
  return (
    <img
      src={objectUrl}
      alt=""
      aria-hidden
      className="h-8 w-8 shrink-0 object-contain invert"
    />
  );
}
