import { describe, it, expect, vi } from 'vitest';

import { RemoteService } from '@app/main/services/remote-service';

function makeOkFetch(body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  }) as never;
}

function makeErrFetch(status: number): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
  }) as never;
}

function makeThrowFetch(): typeof fetch {
  return vi.fn().mockRejectedValue(new Error('Network failure')) as never;
}

describe('RemoteService.probe', () => {
  it('returns available=true and caches version on 200', async () => {
    const svc = new RemoteService({ fetch: makeOkFetch({ version: '1.2.3' }) });
    const result = await svc.probe('192.168.1.10');
    expect(result).toEqual({ available: true, version: '1.2.3' });
    expect(svc.getStatus('192.168.1.10')).toEqual({ available: true, version: '1.2.3' });
  });

  it('returns version=null when sysinfo body omits version', async () => {
    const svc = new RemoteService({ fetch: makeOkFetch({}) });
    const result = await svc.probe('192.168.1.10');
    expect(result).toEqual({ available: true, version: null });
  });

  it('returns available=false on non-200 response', async () => {
    const svc = new RemoteService({ fetch: makeErrFetch(404) });
    const result = await svc.probe('192.168.1.10');
    expect(result).toEqual({ available: false, version: null });
  });

  it('returns available=false on network error', async () => {
    const svc = new RemoteService({ fetch: makeThrowFetch() });
    const result = await svc.probe('192.168.1.10');
    expect(result).toEqual({ available: false, version: null });
  });

  it('caches unavailable result on failure', async () => {
    const svc = new RemoteService({ fetch: makeThrowFetch() });
    await svc.probe('192.168.1.10');
    expect(svc.getStatus('192.168.1.10')).toEqual({ available: false, version: null });
  });
});

describe('RemoteService.getStatus', () => {
  it('returns unavailable for unknown host', () => {
    const svc = new RemoteService();
    expect(svc.getStatus('192.168.1.99')).toEqual({ available: false, version: null });
  });

  it('returns unavailable when host is null', () => {
    const svc = new RemoteService();
    expect(svc.getStatus(null)).toEqual({ available: false, version: null });
  });
});

describe('RemoteService.launch', () => {
  it('returns ok:true on 200', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never;
    const svc = new RemoteService({ fetch: mockFetch });
    const result = await svc.launch('192.168.1.10', '/media/fat/games/SNES/Mario.sfc');
    expect(result).toEqual({ ok: true, httpStatus: 200 });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.1.10:8182/api/launch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/media/fat/games/SNES/Mario.sfc' }),
      }),
    );
  });

  it('returns ok:false with httpStatus on non-2xx', async () => {
    const svc = new RemoteService({ fetch: makeErrFetch(503) as never });
    const result = await svc.launch('192.168.1.10', '/media/fat/_Arcade/Galaga.mra');
    expect(result).toEqual({ ok: false, httpStatus: 503 });
  });

  it('returns ok:false, httpStatus:0 on network error', async () => {
    const svc = new RemoteService({ fetch: makeThrowFetch() });
    const result = await svc.launch('192.168.1.10', '/media/fat/games/SNES/Mario.sfc');
    expect(result).toEqual({ ok: false, httpStatus: 0 });
  });

  it('returns ok:false, httpStatus:0 when host is null', async () => {
    const svc = new RemoteService();
    const result = await svc.launch(null, '/media/fat/games/SNES/Mario.sfc');
    expect(result).toEqual({ ok: false, httpStatus: 0 });
  });
});

describe('RemoteService.clearStatus / clearAll', () => {
  it('clearStatus drops the cached status for the given host', async () => {
    const svc = new RemoteService({ fetch: makeOkFetch({ version: '1.0' }) });
    await svc.probe('192.168.1.10');
    svc.clearStatus('192.168.1.10');
    expect(svc.getStatus('192.168.1.10')).toEqual({ available: false, version: null });
  });

  it('clearAll drops all cached statuses', async () => {
    const svc = new RemoteService({ fetch: makeOkFetch({ version: '1.0' }) });
    await svc.probe('192.168.1.10');
    await svc.probe('192.168.1.11');
    svc.clearAll();
    expect(svc.getStatus('192.168.1.10')).toEqual({ available: false, version: null });
    expect(svc.getStatus('192.168.1.11')).toEqual({ available: false, version: null });
  });
});
