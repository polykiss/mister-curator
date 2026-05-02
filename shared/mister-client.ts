import type { Core, MisterProfile, Rom } from '@shared/types';

export type MisterSecret =
  | { readonly type: 'key'; readonly privateKey: string }
  | { readonly type: 'password'; readonly password: string };

export interface RomVisibilityChange {
  readonly filename: string;
  readonly hidden: boolean;
}

export interface IMisterClient {
  connect(profile: MisterProfile, secret: MisterSecret): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  listCores(): Promise<Core[]>;
  listRoms(coreId: string): Promise<Rom[]>;

  setRomVisibility(coreId: string, filename: string, hidden: boolean): Promise<void>;
  setBulkRomVisibility(coreId: string, changes: RomVisibilityChange[]): Promise<void>;
}
