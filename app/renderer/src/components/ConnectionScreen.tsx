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
    <div className="mx-auto w-full max-w-2xl px-6 py-12">
      <header className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">MiSTerCurator</h1>
          <p className="text-sm text-muted-foreground">
            Pick a profile to connect, or add one to get started.
          </p>
        </div>
        <Button onClick={openAdd}>
          <Plus />
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
  );
}
