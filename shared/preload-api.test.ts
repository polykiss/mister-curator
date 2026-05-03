import { afterEach, describe, expect, it } from 'vitest';

import {
  __TEST_IPC_ERROR_MARKER,
  decodeIpcError,
  encodeIpcError,
  setMisterConnectionErrorFactory,
} from '@shared/preload-api';
import { MisterConnectionError } from '@shared/types';

afterEach(() => {
  // Reset the factory so tests stay independent. The fallback path
  // is deliberately exercised by the "no factory" test; everything
  // else installs the real one first.
  setMisterConnectionErrorFactory(
    (code, message) => new MisterConnectionError(code, message),
  );
});

describe('encodeIpcError', () => {
  it('wraps a MisterConnectionError into an Error whose message carries the marker payload', () => {
    const original = new MisterConnectionError(
      'unreachable',
      'Could not reach 192.168.1.50',
    );

    const encoded = encodeIpcError(original);

    expect(encoded).toBeInstanceOf(Error);
    const message = (encoded as Error).message;
    expect(message).toContain(__TEST_IPC_ERROR_MARKER);
    // Payload after the marker is JSON with the typed fields.
    const json = message.slice(
      message.indexOf(__TEST_IPC_ERROR_MARKER) + __TEST_IPC_ERROR_MARKER.length,
    );
    expect(JSON.parse(json)).toEqual({
      kind: 'MisterConnectionError',
      code: 'unreachable',
      message: 'Could not reach 192.168.1.50',
    });
  });

  it('handles each ConnectionErrorCode round-trip', () => {
    for (const code of ['unreachable', 'auth_failed', 'not_a_mister', 'unknown'] as const) {
      const err = new MisterConnectionError(code, `msg for ${code}`);
      const encoded = encodeIpcError(err);
      const decoded = decodeIpcError(encoded);
      expect(decoded).toBeInstanceOf(MisterConnectionError);
      expect((decoded as MisterConnectionError).code).toBe(code);
      expect((decoded as MisterConnectionError).message).toBe(`msg for ${code}`);
    }
  });

  it('passes plain Errors through unchanged', () => {
    const plain = new Error('boom');
    const encoded = encodeIpcError(plain);
    expect(encoded).toBe(plain);
  });

  it('passes non-Error throwables through unchanged', () => {
    expect(encodeIpcError('string error')).toBe('string error');
    expect(encodeIpcError(42)).toBe(42);
    expect(encodeIpcError(null)).toBe(null);
    expect(encodeIpcError(undefined)).toBe(undefined);
  });
});

describe('decodeIpcError', () => {
  it('reconstructs a MisterConnectionError when the marker is present at the end of the wrapped message', () => {
    const original = new MisterConnectionError(
      'auth_failed',
      'Login failed.',
    );
    const encoded = encodeIpcError(original) as Error;

    // Simulate Electron's wrap: it prepends "Error invoking remote
    // method 'mister:connect': Error: " before the original message.
    const wrapped = new Error(
      `Error invoking remote method 'mister:connect': Error: ${encoded.message}`,
    );

    const decoded = decodeIpcError(wrapped);

    expect(decoded).toBeInstanceOf(MisterConnectionError);
    expect((decoded as MisterConnectionError).code).toBe('auth_failed');
    expect((decoded as MisterConnectionError).message).toBe('Login failed.');
  });

  it('returns the raw error when the marker is not present (plain rejection)', () => {
    const plain = new Error('Something else went wrong');
    expect(decodeIpcError(plain)).toBe(plain);
  });

  it('returns the raw error when the marker JSON is malformed', () => {
    const broken = new Error(`${__TEST_IPC_ERROR_MARKER}{not valid json`);
    expect(decodeIpcError(broken)).toBe(broken);
  });

  it('returns the raw error when the code is not one of the known set', () => {
    const bogus = new Error(
      `${__TEST_IPC_ERROR_MARKER}${JSON.stringify({
        kind: 'MisterConnectionError',
        code: 'never_heard_of_this',
        message: 'x',
      })}`,
    );
    // Falls through to the raw error since we refuse to widen the
    // ConnectionErrorCode union from an untrusted payload.
    expect(decodeIpcError(bogus)).toBe(bogus);
  });

  it('returns the raw error when the kind is not MisterConnectionError', () => {
    const wrong = new Error(
      `${__TEST_IPC_ERROR_MARKER}${JSON.stringify({
        kind: 'SomeOtherError',
        code: 'unknown',
        message: 'x',
      })}`,
    );
    expect(decodeIpcError(wrong)).toBe(wrong);
  });

  it('handles non-Error inputs without throwing', () => {
    expect(decodeIpcError('a string')).toBe('a string');
    expect(decodeIpcError(null)).toBe(null);
    expect(decodeIpcError({ random: true })).toEqual({ random: true });
  });
});

describe('setMisterConnectionErrorFactory', () => {
  it('uses the supplied factory to build the rebuilt error', () => {
    const built: { code: string; message: string }[] = [];
    setMisterConnectionErrorFactory((code, message) => {
      built.push({ code, message });
      const err = new Error(`custom: ${message}`);
      Object.assign(err, { name: 'MisterConnectionError', code });
      return err;
    });

    const encoded = encodeIpcError(
      new MisterConnectionError('not_a_mister', 'No /media/fat/games'),
    );
    const decoded = decodeIpcError(encoded) as Error & { code: string };

    expect(built).toEqual([
      { code: 'not_a_mister', message: 'No /media/fat/games' },
    ]);
    expect(decoded.message).toBe('custom: No /media/fat/games');
    expect(decoded.code).toBe('not_a_mister');
  });
});
