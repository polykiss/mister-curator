import type { IMisterClient, MisterSecret, RomVisibilityChange } from '@shared/mister-client';
import type { ConnectionStatus, Core, Rom } from '@shared/types';

import type { ProfileStore } from '@app/main/storage/profile-store';

type StatusListener = (status: ConnectionStatus) => void;

/**
 * Owns the singleton IMisterClient and the ConnectionStatus state machine.
 * Renderer talks to this through IPC; main pushes status transitions back to
 * any registered listener (typically a window.webContents.send adapter).
 */
export class ConnectionManager {
  private status: ConnectionStatus = 'disconnected';
  private currentProfileId: string | null = null;
  private readonly listeners = new Set<StatusListener>();

  constructor(
    private readonly client: IMisterClient,
    private readonly store: ProfileStore,
  ) {}

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getCurrentProfileId(): string | null {
    return this.currentProfileId;
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(profileId: string): Promise<void> {
    if (this.status === 'connected') {
      // Drop the previous connection cleanly before opening a new one.
      try {
        await this.client.disconnect();
      } catch {
        // Best-effort; we're about to start fresh anyway.
      }
    }

    this.setStatus('connecting');

    try {
      const profile = await this.store.get(profileId);
      if (!profile) {
        throw new Error(`Profile not found: ${profileId}`);
      }
      const secret: MisterSecret = await this.store.getSecret(profileId);
      await this.client.connect(profile, secret);
      this.currentProfileId = profileId;
      this.setStatus('connected');
    } catch (err) {
      this.currentProfileId = null;
      this.setStatus('error');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.disconnect();
    } finally {
      this.currentProfileId = null;
      this.setStatus('disconnected');
    }
  }

  async listCores(): Promise<Core[]> {
    this.assertConnected();
    return this.client.listCores();
  }

  async listRoms(coreId: string): Promise<Rom[]> {
    this.assertConnected();
    return this.client.listRoms(coreId);
  }

  async setRomVisibility(coreId: string, filename: string, hidden: boolean): Promise<void> {
    this.assertConnected();
    await this.client.setRomVisibility(coreId, filename, hidden);
  }

  async setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChange[],
  ): Promise<void> {
    this.assertConnected();
    await this.client.setBulkRomVisibility(coreId, changes);
  }

  private assertConnected(): void {
    if (this.status !== 'connected') {
      throw new Error('Not connected to a MiSTer.');
    }
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}
