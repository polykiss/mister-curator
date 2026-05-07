import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import type { MisterProfile } from '@shared/types';

import { ProfileDialog } from '@app/renderer/src/components/ProfileDialog';
import { ProfileList } from '@app/renderer/src/components/ProfileList';
import { Button } from '@app/renderer/src/components/ui/button';

export function ConnectionScreen(): JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<MisterProfile | undefined>(undefined);

  const openAdd = (): void => {
    setEditingProfile(undefined);
    setDialogOpen(true);
  };

  const openEdit = (profile: MisterProfile): void => {
    setEditingProfile(profile);
    setDialogOpen(true);
  };

  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto w-full max-w-2xl px-8 pt-24 pb-12">
        <header className="mb-12 flex items-end justify-between gap-6">
          <div className="flex flex-col gap-3">
            {/* Wordmark in IBM Plex Sans 700, display size, -0.02em
                tracking per SYSTEM.md §5. The "MiSTer" / "Curator"
                split keeps the brand legible at 40px without breaking
                the existing identity. */}
            <h1 className="text-display text-fg">MiSTerCurator</h1>
            <p className="max-w-md text-body-lg text-fg-muted">
              Pick a profile to connect, or add one to get started.
            </p>
          </div>
          <Button variant="primary" onClick={openAdd}>
            <Plus strokeWidth={1.5} />
            Add profile
          </Button>
        </header>

        <ProfileList onEdit={openEdit} />

        <ProfileDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          profile={editingProfile}
          onSaveError={(message) => {
            toast.error('Could not save profile', { description: message });
          }}
        />
      </div>
    </div>
  );
}
