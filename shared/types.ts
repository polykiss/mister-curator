export interface MisterProfile {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly authMethod: 'key' | 'password';
  readonly keyPath?: string;
}

export interface Core {
  readonly id: string;
  readonly name: string;
  readonly romCount: number;
  readonly hiddenCount: number;
}

export interface Rom {
  readonly coreId: string;
  readonly filename: string;
  readonly displayName: string;
  readonly sizeBytes: number;
  readonly hidden: boolean;
  readonly path: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type ConnectionErrorCode = 'unreachable' | 'auth_failed' | 'not_a_mister' | 'unknown';

export interface ConnectionError {
  readonly code: ConnectionErrorCode;
  readonly message: string;
}

export class MisterConnectionError extends Error implements ConnectionError {
  readonly code: ConnectionErrorCode;

  constructor(code: ConnectionErrorCode, message: string) {
    super(message);
    this.name = 'MisterConnectionError';
    this.code = code;
  }
}
