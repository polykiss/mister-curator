import { Loader2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import type { MisterSecret } from '@shared/mister-client';
import type { MisterProfile } from '@shared/types';

import { Button } from '@app/renderer/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';
import { Input } from '@app/renderer/src/components/ui/input';
import { Label } from '@app/renderer/src/components/ui/label';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';

type AuthMethod = 'password' | 'key';
type KeySource = 'paste' | 'file';

interface ProfileDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly profile?: MisterProfile;
  readonly onSaveError: (message: string) => void;
}

interface FormState {
  readonly name: string;
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly authMethod: AuthMethod;
  readonly password: string;
  readonly keySource: KeySource;
  readonly keyContent: string;
  readonly keyPath: string | null;
}

function createBlankForm(profile?: MisterProfile): FormState {
  return {
    name: profile?.name ?? '',
    host: profile?.host ?? '',
    port: String(profile?.port ?? 22),
    username: profile?.username ?? 'root',
    authMethod: profile?.authMethod ?? 'password',
    password: '',
    keySource: 'paste',
    keyContent: '',
    keyPath: null,
  };
}

export function ProfileDialog({
  open,
  onOpenChange,
  profile,
  onSaveError,
}: ProfileDialogProps): JSX.Element {
  const { saveProfile } = useConnection();
  const [form, setForm] = useState<FormState>(() => createBlankForm(profile));
  const [submitting, setSubmitting] = useState(false);
  const [pickingKey, setPickingKey] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(createBlankForm(profile));
      setSubmitting(false);
    }
  }, [open, profile]);

  const isEdit = profile !== undefined;
  const portNumber = Number.parseInt(form.port, 10);
  const portValid = Number.isFinite(portNumber) && portNumber > 0 && portNumber <= 65535;

  const canSubmit =
    form.name.trim() !== '' &&
    form.host.trim() !== '' &&
    form.username.trim() !== '' &&
    portValid &&
    (form.authMethod === 'password'
      ? form.password.length > 0
      : form.keyContent.length > 0);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const onPickKey = async (): Promise<void> => {
    setPickingKey(true);
    try {
      const picked = await window.mister.pickKeyFile();
      if (picked) {
        setForm((prev) => ({
          ...prev,
          keyPath: picked.path,
          keyContent: picked.content,
        }));
      }
    } catch (err) {
      onSaveError(err instanceof Error ? err.message : 'Could not read key file.');
    } finally {
      setPickingKey(false);
    }
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);

    const profileId =
      profile?.id ??
      (typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `profile-${String(Date.now())}-${String(Math.floor(Math.random() * 1e9))}`);

    const nextProfile: MisterProfile = {
      id: profileId,
      name: form.name.trim(),
      host: form.host.trim(),
      port: portNumber,
      username: form.username.trim(),
      authMethod: form.authMethod,
    };
    const secret: MisterSecret =
      form.authMethod === 'password'
        ? { type: 'password', password: form.password }
        : { type: 'key', privateKey: form.keyContent };

    try {
      await saveProfile(nextProfile, secret);
      onOpenChange(false);
    } catch (err) {
      onSaveError(err instanceof Error ? err.message : 'Could not save profile.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit profile' : 'Add MiSTer profile'}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'Re-enter the password or key to save changes — credentials are never sent back to the UI.'
                : 'Saved credentials are encrypted with your OS keyring before they touch disk.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                placeholder="Living Room"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                autoFocus
              />
            </div>

            <div className="grid grid-cols-[1fr_120px] gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="profile-host">Host</Label>
                <Input
                  id="profile-host"
                  placeholder="192.168.1.42"
                  value={form.host}
                  onChange={(e) => update('host', e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-port">Port</Label>
                <Input
                  id="profile-port"
                  type="number"
                  inputMode="numeric"
                  value={form.port}
                  onChange={(e) => update('port', e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="profile-username">Username</Label>
              <Input
                id="profile-username"
                value={form.username}
                onChange={(e) => update('username', e.target.value)}
              />
            </div>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium leading-none">Authentication</legend>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="authMethod"
                    value="password"
                    checked={form.authMethod === 'password'}
                    onChange={() => update('authMethod', 'password')}
                  />
                  Password
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="authMethod"
                    value="key"
                    checked={form.authMethod === 'key'}
                    onChange={() => update('authMethod', 'key')}
                  />
                  SSH key
                </label>
              </div>
            </fieldset>

            {form.authMethod === 'password' ? (
              <div className="grid gap-1.5">
                <Label htmlFor="profile-password">Password</Label>
                <Input
                  id="profile-password"
                  type="password"
                  autoComplete="off"
                  value={form.password}
                  onChange={(e) => update('password', e.target.value)}
                />
              </div>
            ) : (
              <div className="grid gap-2">
                <div className="flex gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="keySource"
                      value="paste"
                      checked={form.keySource === 'paste'}
                      onChange={() => update('keySource', 'paste')}
                    />
                    Paste key contents
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="keySource"
                      value="file"
                      checked={form.keySource === 'file'}
                      onChange={() => update('keySource', 'file')}
                    />
                    Choose file
                  </label>
                </div>

                {form.keySource === 'paste' ? (
                  <textarea
                    className="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    value={form.keyContent}
                    onChange={(e) => update('keyContent', e.target.value)}
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void onPickKey()}
                      disabled={pickingKey}
                    >
                      {pickingKey ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Upload />
                      )}
                      Browse…
                    </Button>
                    <span className="truncate text-xs text-muted-foreground">
                      {form.keyPath ?? 'No file selected.'}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || submitting}>
              {submitting ? <Loader2 className="animate-spin" /> : null}
              {isEdit ? 'Save changes' : 'Add profile'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
