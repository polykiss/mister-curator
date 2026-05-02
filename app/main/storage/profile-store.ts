import { promises as fs } from 'node:fs';

import { safeStorage } from 'electron';

import type { MisterSecret } from '@shared/mister-client';
import type { MisterProfile } from '@shared/types';

export interface ProfileStorePaths {
  readonly profilesPath: string;
  readonly secretsPath: string;
}

interface ProfilesFileShape {
  readonly profiles: readonly MisterProfile[];
}

type SecretsFileShape = Record<string, string>;

const ENCRYPTION_UNAVAILABLE_MESSAGE =
  'Secure credential storage is unavailable on this system. ' +
  'On Linux, install gnome-keyring or kwallet and re-launch. ' +
  'MiSTerCurator refuses to write SSH credentials in plaintext.';

export class ProfileStore {
  constructor(private readonly paths: ProfileStorePaths) {}

  async list(): Promise<MisterProfile[]> {
    const data = await readJson<ProfilesFileShape>(this.paths.profilesPath, { profiles: [] });
    return [...data.profiles];
  }

  async get(profileId: string): Promise<MisterProfile | undefined> {
    const profiles = await this.list();
    return profiles.find((p) => p.id === profileId);
  }

  async upsert(profile: MisterProfile, secret: MisterSecret): Promise<void> {
    assertEncryptionAvailable();
    if (profile.authMethod !== secret.type) {
      throw new Error(
        `Profile authMethod '${profile.authMethod}' does not match secret of type '${secret.type}'.`,
      );
    }

    const existing = await this.list();
    const next = upsertById(existing, profile);
    await writeJson(this.paths.profilesPath, { profiles: next });

    const secrets = await readJson<SecretsFileShape>(this.paths.secretsPath, {});
    const encrypted = safeStorage.encryptString(JSON.stringify(secret));
    secrets[profile.id] = encrypted.toString('base64');
    await writeJson(this.paths.secretsPath, secrets);
  }

  async delete(profileId: string): Promise<void> {
    const profiles = await this.list();
    const next = profiles.filter((p) => p.id !== profileId);
    await writeJson(this.paths.profilesPath, { profiles: next });

    const secrets = await readJson<SecretsFileShape>(this.paths.secretsPath, {});
    if (profileId in secrets) {
      delete secrets[profileId];
      await writeJson(this.paths.secretsPath, secrets);
    }
  }

  async getSecret(profileId: string): Promise<MisterSecret> {
    assertEncryptionAvailable();
    const secrets = await readJson<SecretsFileShape>(this.paths.secretsPath, {});
    const blob = secrets[profileId];
    if (blob === undefined) {
      throw new Error(`No stored credentials for profile '${profileId}'.`);
    }
    const buffer = Buffer.from(blob, 'base64');
    const decrypted = safeStorage.decryptString(buffer);
    const parsed: unknown = JSON.parse(decrypted);
    if (!isMisterSecret(parsed)) {
      throw new Error(`Stored credentials for profile '${profileId}' are corrupt.`);
    }
    return parsed;
  }
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(ENCRYPTION_UNAVAILABLE_MESSAGE);
  }
}

function upsertById(
  profiles: readonly MisterProfile[],
  profile: MisterProfile,
): MisterProfile[] {
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx < 0) return [...profiles, profile];
  const next = [...profiles];
  next[idx] = profile;
  return next;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return structuredClone(fallback);
    }
    throw err;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(filePath, json, { encoding: 'utf-8', mode: 0o600 });
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isMisterSecret(value: unknown): value is MisterSecret {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'password' && typeof v.password === 'string') return true;
  if (v.type === 'key' && typeof v.privateKey === 'string') return true;
  return false;
}
