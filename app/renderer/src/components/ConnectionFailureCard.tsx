import { AlertCircle, Pencil, RotateCcw, X } from 'lucide-react';
import type { JSX } from 'react';

import { formatConnectionErrorMessage } from '@shared/connection';
import type { MisterProfile } from '@shared/types';

import type { ConnectionFailureInfo } from '@app/renderer/src/contexts/ConnectionContext';
import { Button } from '@app/renderer/src/components/ui/button';

interface ConnectionFailureCardProps {
  readonly profile: MisterProfile;
  readonly failure: ConnectionFailureInfo;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly onEdit: () => void;
  readonly onDismiss: () => void;
}

/**
 * Sticky inline failure card rendered directly under the profile row
 * that failed. Persistent — does not auto-dismiss like a toast — so
 * the user can read it, then decide whether to retry, edit, or
 * dismiss.
 */
export function ConnectionFailureCard({
  profile,
  failure,
  retrying,
  onRetry,
  onEdit,
  onDismiss,
}: ConnectionFailureCardProps): JSX.Element {
  const message = formatConnectionErrorMessage(failure.code, {
    profile,
    underlyingMessage: failure.underlyingMessage,
  });
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
    >
      <div className="flex items-start gap-3">
        <AlertCircle
          className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-destructive">{message}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={onRetry}
              disabled={retrying}
            >
              <RotateCcw />
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Pencil />
              Edit profile
            </Button>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
          className="-mr-1 -mt-1 h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X />
        </Button>
      </div>
    </div>
  );
}
