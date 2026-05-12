import { Loader2, Pencil, Plug, Trash2 } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { formatConnectingMessage } from '@shared/connection';
import { MisterConnectionError } from '@shared/types';
import type { MisterProfile } from '@shared/types';

import { ConnectionFailureCard } from '@app/renderer/src/components/ConnectionFailureCard';
import { Button } from '@app/renderer/src/components/ui/button';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';

interface ProfileListProps {
  readonly onEdit: (profile: MisterProfile) => void;
}

export function ProfileList({ onEdit }: ProfileListProps): JSX.Element {
  const {
    profiles,
    profilesLoading,
    currentProfile,
    status,
    connect,
    deleteProfile,
    failureByProfileId,
    dismissFailure,
    connectingProfileId,
    connectingElapsedMs,
    connectingPhase,
  } = useConnection();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  if (profilesLoading) {
    return <p className="text-body-sm text-fg-muted">Loading profiles…</p>;
  }

  if (profiles.length === 0) {
    return (
      <div className="rounded border border-dashed border-emphasis bg-surface p-12 text-center">
        <p className="text-body text-fg-body">
          No saved profiles yet.
        </p>
        <p className="mt-1 text-body-sm text-fg-muted">
          Click <span className="font-medium text-fg">Add profile</span> to connect to your
          first MiSTer.
        </p>
      </div>
    );
  }

  const onConnect = async (profile: MisterProfile): Promise<void> => {
    setPendingId(profile.id);
    try {
      const result = await connect(profile.id);
      if (result.reappliedCount > 0) {
        const noun = result.reappliedCount === 1 ? 'core' : 'cores';
        toast.info(
          `Re-applied ${String(result.reappliedCount)} hidden ${noun} after update.`,
        );
      }
      // feat/arcade-ux-and-ledger (PR 2/2) — one-shot toast on
      // the first connect that produces an auto-hide ledger. The
      // backend only flips this field on the EMPTY→non-empty edge
      // (not on every reconnect), so the toast doesn't re-pester
      // after the initial cutover. The user can toggle the rule
      // off via the Arcade pane checkbox the toast points at.
      if (
        result.firstConnectArcadeAutoHidden !== null &&
        result.firstConnectArcadeAutoHidden > 0
      ) {
        const n = result.firstConnectArcadeAutoHidden;
        const noun = n === 1 ? 'arcade game' : 'arcade games';
        toast.info(
          `Auto-hid ${String(n)} ${noun} with missing ROMs.`,
          {
            description:
              'Toggle "Auto-hide missing ROMs" off in the Arcade pane to restore them.',
          },
        );
      }
    } catch (err) {
      // Failure recording is handled inside `connect()` (see
      // ConnectionContext) so the inline failure card picks it up.
      // We log unexpected non-MisterConnectionError throws so they
      // surface in the dev console — no toasts.
      if (!(err instanceof MisterConnectionError)) {
        console.error(err);
      }
    } finally {
      setPendingId(null);
    }
  };

  const onDelete = async (profile: MisterProfile): Promise<void> => {
    try {
      await deleteProfile(profile.id);
      toast.success(`Removed “${profile.name}”.`);
    } catch (err) {
      toast.error('Could not delete profile', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    } finally {
      setConfirmDeleteId(null);
    }
  };

  return (
    <ul className="grid gap-2">
      {profiles.map((profile) => {
        // The "connecting" row state — we only show the in-row spinner
        // and elapsed message once the reveal-delay window has passed
        // (so fast connects don't flicker).
        const isConnecting =
          (pendingId === profile.id || currentProfile?.id === profile.id) &&
          status === 'connecting';
        const isPending = confirmDeleteId === profile.id;
        const failure = failureByProfileId.get(profile.id);
        const isThisProfileConnecting =
          connectingProfileId === profile.id && status === 'connecting';
        const connectingMessage = isThisProfileConnecting
          ? formatConnectingMessage(connectingElapsedMs, connectingPhase)
          : null;

        return (
          <Fragment key={profile.id}>
            <li className="flex items-center justify-between gap-3 rounded border border-default bg-surface px-5 py-4 transition-colors hover:border-emphasis">
              <div className="min-w-0">
                <div className="truncate text-body font-medium text-fg">
                  {profile.name}
                </div>
                <div className="truncate font-mono text-body-sm text-fg-muted">
                  {profile.username}@{profile.host}:{profile.port}
                </div>
                {connectingMessage !== null ? (
                  // Reveal-delay window from PR #9: the elapsed-message
                  // line only appears after the threshold elapses, so a
                  // fast connect never flashes it. Mono carries the
                  // counter so the digits stay aligned as they tick.
                  <div className="mt-1.5 flex items-center gap-2 text-body-sm text-fg-muted">
                    <Loader2
                      className="size-3 shrink-0 animate-spin"
                      strokeWidth={1.5}
                      aria-hidden
                    />
                    <span className="truncate font-mono tabular">
                      {connectingMessage}
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {isPending ? (
                  <>
                    <span className="text-body-sm text-fg-muted">Delete?</span>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void onDelete(profile)}
                    >
                      Yes, delete
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={isConnecting}
                      onClick={() => void onConnect(profile)}
                    >
                      {isConnecting ? (
                        <Loader2 className="animate-spin" strokeWidth={1.5} />
                      ) : (
                        <Plug strokeWidth={1.5} />
                      )}
                      {isConnecting ? 'Connecting…' : 'Connect'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${profile.name}`}
                      onClick={() => onEdit(profile)}
                    >
                      <Pencil strokeWidth={1.5} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${profile.name}`}
                      onClick={() => setConfirmDeleteId(profile.id)}
                    >
                      <Trash2 strokeWidth={1.5} />
                    </Button>
                  </>
                )}
              </div>
            </li>
            {failure !== undefined ? (
              // Sticky failure card lives directly under the failed
              // row so the relationship is unambiguous when several
              // profiles are listed.
              <li>
                <ConnectionFailureCard
                  profile={profile}
                  failure={failure}
                  retrying={pendingId === profile.id || isConnecting}
                  onRetry={() => void onConnect(profile)}
                  onEdit={() => onEdit(profile)}
                  onDismiss={() => dismissFailure(profile.id)}
                />
              </li>
            ) : null}
          </Fragment>
        );
      })}
    </ul>
  );
}
