import type { MisterApi } from '@shared/preload-api';

declare global {
  interface Window {
    readonly mister: MisterApi;
  }
}

export {};
