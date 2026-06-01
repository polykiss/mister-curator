import { Gamepad2 } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Skeleton } from '@app/renderer/src/components/ui/skeleton';

interface Props {
  readonly url: string | null;
}

export function CoreLogo({ url }: Props): JSX.Element {
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

  if (url === null) {
    return (
      <Gamepad2
        className="h-8 w-8 shrink-0 text-fg-muted"
        strokeWidth={1.5}
        aria-hidden
      />
    );
  }

  if (objectUrl === null) {
    return <Skeleton className="h-8 w-8 shrink-0 rounded" />;
  }

  // logo-monochrome variant — invert renders black-on-transparent as white on dark bg.
  // When wheel/color logos are added, gate this conditionally.
  return (
    <img
      src={objectUrl}
      alt=""
      aria-hidden
      className="h-8 w-8 shrink-0 object-contain invert"
    />
  );
}
