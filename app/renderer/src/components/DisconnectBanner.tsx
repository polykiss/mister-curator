import { AlertTriangle, Loader2, Plug, Power } from 'lucide-react';
import type { JSX } from 'react';

import { Button } from '@app/renderer/src/components/ui/button';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';

/**
 * Persistent banner shown at the top of the BrowserScreen while the
 * SSH transport is dropped. While auto-retry is in progress the copy
 * is informational ("Reconnecting (1/3)…"); after retries are
 * exhausted it offers Reconnect / Disconnect actions. Filters and
 * navigation underneath stay enabled — only mutating actions disable.
 *
 * Visual shape follows SYSTEM.md §5 banner pattern: 2px left border
 * in the destructive color (the situation IS destructive), no fill,
 * content carries hierarchy through weight and color.
 */
export function DisconnectBanner(): JSX.Element | null {
  const {
    lostConnection,
    autoRetry,
    autoRetryFailed,
    currentProfile,
    reconnect,
    disconnect,
  } = useConnection();

  if (!lostConnection) return null;

  const profileName = currentProfile?.name ?? 'this MiSTer';
  const retrying = autoRetry !== null && !autoRetryFailed;
  const headline = retrying
    ? `Reconnecting to ${profileName}… (attempt ${String(autoRetry.attempt)} of ${String(autoRetry.totalAttempts)})`
    : `Connection to ${profileName} was lost.`;

  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-subtle border-l-2 border-l-destructive bg-surface px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-2 text-body text-fg">
        {retrying ? (
          <Loader2
            className="size-4 shrink-0 animate-spin text-destructive"
            strokeWidth={1.5}
            aria-hidden
          />
        ) : (
          <AlertTriangle
            className="size-4 shrink-0 text-destructive"
            strokeWidth={1.5}
            aria-hidden
          />
        )}
        <span className="truncate font-medium">{headline}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void reconnect()}
          disabled={retrying}
        >
          <Plug strokeWidth={1.5} />
          Reconnect
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void disconnect()}
        >
          <Power strokeWidth={1.5} />
          Disconnect
        </Button>
      </div>
    </div>
  );
}
