import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn().mockReturnValue(true),
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf-8')),
  decryptString: vi.fn((b: Buffer) =>
    b.toString('utf-8').replace(/^enc:/, ''),
  ),
}));

vi.mock('electron', () => ({ safeStorage: safeStorageMock }));

const { ProfileStore } = await import('@app/main/storage/profile-store');
import type { MisterProfile } from '@shared/types';
import type { MisterSecret } from '@shared/mister-client';

const baseProfile: MisterProfile = {
  id: 'p-1',
  name: 'Living Room',
  host: '192.168.1.42',
  port: 22,
  username: 'root',
  authMethod: 'password',
};

const baseSecret: MisterSecret = { type: 'password', password: 'hunter2' };

describe('ProfileStore', () => {
  let tempDir: string;
  let store: InstanceType<typeof ProfileStore>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-store-'));
    store = new ProfileStore({
      profilesPath: path.join(tempDir, 'profiles.json'),
      secretsPath: path.join(tempDir, 'secrets.json'),
    });
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockClear();
    safeStorageMock.decryptString.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns an empty list when profiles.json does not exist yet', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('upserts a new profile and persists it to disk', async () => {
    await store.upsert(baseProfile, baseSecret);
    const list = await store.list();
    expect(list).toEqual([baseProfile]);

    const onDisk = await fs.readFile(path.join(tempDir, 'profiles.json'), 'utf-8');
    expect(JSON.parse(onDisk)).toEqual({ profiles: [baseProfile] });
  });

  it('routes the secret through safeStorage.encryptString before writing', async () => {
    await store.upsert(baseProfile, baseSecret);

    expect(safeStorageMock.encryptString).toHaveBeenCalledTimes(1);
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith(JSON.stringify(baseSecret));

    const onDisk = JSON.parse(
      await fs.readFile(path.join(tempDir, 'secrets.json'), 'utf-8'),
    ) as Record<string, string>;
    expect(typeof onDisk['p-1']).toBe('string');
    // The on-disk value is the base64 of whatever encryptString returned —
    // i.e. the store does not skip encryption for any code path.
    const expected = Buffer.from(`enc:${JSON.stringify(baseSecret)}`, 'utf-8').toString(
      'base64',
    );
    expect(onDisk['p-1']).toBe(expected);
  });

  it('writes secrets.json with mode 0600', async () => {
    await store.upsert(baseProfile, baseSecret);
    const stat = await fs.stat(path.join(tempDir, 'secrets.json'));
    // Mode bits include the file type; mask to permissions.
    expect((stat.mode & 0o777).toString(8)).toBe('600');
  });

  it('decrypts the secret back to its original shape on getSecret', async () => {
    await store.upsert(baseProfile, baseSecret);
    const secret = await store.getSecret('p-1');
    expect(secret).toEqual(baseSecret);
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1);
  });

  it('updates an existing profile in place when ids match', async () => {
    await store.upsert(baseProfile, baseSecret);
    const updated: MisterProfile = { ...baseProfile, name: 'Bedroom' };
    await store.upsert(updated, { type: 'password', password: 'newpass' });

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('Bedroom');

    const secret = await store.getSecret('p-1');
    expect(secret).toEqual({ type: 'password', password: 'newpass' });
  });

  it('deletes both the profile entry and its secret', async () => {
    await store.upsert(baseProfile, baseSecret);
    await store.delete('p-1');

    expect(await store.list()).toEqual([]);
    await expect(store.getSecret('p-1')).rejects.toThrow(/No stored credentials/);
  });

  it('rejects upserts when authMethod and secret type disagree', async () => {
    await expect(
      store.upsert(
        { ...baseProfile, authMethod: 'key' },
        { type: 'password', password: 'x' },
      ),
    ).rejects.toThrow(/does not match/);
  });

  it('throws a clear error when safeStorage is unavailable on upsert', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    await expect(store.upsert(baseProfile, baseSecret)).rejects.toThrow(
      /Secure credential storage is unavailable/,
    );
  });

  it('throws a clear error when safeStorage is unavailable on getSecret', async () => {
    await store.upsert(baseProfile, baseSecret);
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    await expect(store.getSecret('p-1')).rejects.toThrow(/Secure credential storage is unavailable/);
  });

  it('throws when getSecret is called for an unknown profile id', async () => {
    await expect(store.getSecret('does-not-exist')).rejects.toThrow(/No stored credentials/);
  });

  it('rejects corrupt stored secrets that do not deserialize to a MisterSecret', async () => {
    await fs.writeFile(
      path.join(tempDir, 'secrets.json'),
      JSON.stringify({
        'p-1': Buffer.from('enc:{"unrelated":"junk"}', 'utf-8').toString('base64'),
      }),
      'utf-8',
    );
    await expect(store.getSecret('p-1')).rejects.toThrow(/corrupt/);
  });
});
