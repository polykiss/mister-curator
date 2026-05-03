import { Loader2, Pencil, Plug, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { MisterConnectionError } from '@shared/types';
import type { MisterProfile } from '@shared/types';

import { Button } from '@app/renderer/src/components/ui/button';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { friendlyConnectionError } from '@app/renderer/src/lib/format';

interface ProfileListProps {
  readonly onEdit: (profile: MisterProfile) => void;
}

export function ProfileList({ onEdit }: ProfileListProps): JSX.Element {
  const { profiles, profilesLoading, currentProfile, status, connect, deleteProfile } =
    useConnection();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  if (profilesLoading) {
    return <p className="text-sm text-muted-foreground">Loading profiles…</p>;
  }

  if (profiles.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        No saved profiles yet. Click <span className="font-medium">Add profile</span> to
        connect to your first MiSTer.
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
    } catch (err) {
      toast.error('Connection failed', {
        description: friendlyConnectionError(err, profile),
      });
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
        const isConnecting =
          (pendingId === profile.id || currentProfile?.id === profile.id) &&
          status === 'connecting';
        const isPending = confirmDeleteId === profile.id;

        return (
          <li
            key={profile.id}
            className="flex items-center justify-between gap-3 rounded-lg border bg-card p-4"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{profile.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {profile.username}@{profile.host}:{profile.port}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {isPending ? (
                <>
                  <span className="text-xs text-muted-foreground">Delete?</span>
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
                    variant="default"
                    size="sm"
                    disabled={isConnecting}
                    onClick={() => void onConnect(profile)}
                  >
                    {isConnecting ? <Loader2 className="animate-spin" /> : <Plug />}
                    {isConnecting ? 'Connecting…' : 'Connect'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${profile.name}`}
                    onClick={() => onEdit(profile)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${profile.name}`}
                    onClick={() => setConfirmDeleteId(profile.id)}
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
