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
  const headline = autoRetry !== null && !autoRetryFailed
    ? `Reconnecting to ${profileName}… (attempt ${String(autoRetry.attempt)} of ${String(autoRetry.totalAttempts)})`
    : `Connection to ${profileName} was lost.`;

  return (
    <div
      role="alert"
      // Destructive-coloured strip pinned to the top of the browser
      // screen. `border-b` keeps it visually distinct from the
      // content underneath without occluding it.
      className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-destructive/40 bg-destructive/15 px-4 py-2 text-sm text-destructive"
    >
      <div className="flex min-w-0 items-center gap-2">
        {autoRetry !== null && !autoRetryFailed ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        )}
        <span className="truncate">{headline}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void reconnect()}
          disabled={autoRetry !== null && !autoRetryFailed}
        >
          <Plug />
          Reconnect
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void disconnect()}
        >
          <Power />
          Disconnect
        </Button>
      </div>
    </div>
  );
}
