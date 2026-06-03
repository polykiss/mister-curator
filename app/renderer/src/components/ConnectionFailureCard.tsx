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
 * Sticky inline failure banner rendered directly under the profile row
 * that failed. Persistent — does not auto-dismiss like a toast — so
 * the user can read it, then decide whether to retry, edit, or
 * dismiss.
 *
 * Visual shape follows SYSTEM.md §5 banner pattern: 2px left border in
 * the destructive color, no fill, content carries hierarchy through
 * weight + color rather than chrome.
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
      className="flex items-start gap-3 border-l-2 border-destructive bg-surface px-4 py-3"
    >
      <AlertCircle
        className="mt-0.5 size-4 shrink-0 text-destructive"
        strokeWidth={1.5}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-fg">{message}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
        >
          <RotateCcw strokeWidth={1.5} />
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Edit profile" title="Edit profile">
          <Pencil strokeWidth={1.5} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
        >
          <X strokeWidth={1.5} />
        </Button>
      </div>
    </div>
  );
}
