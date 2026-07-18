import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { OperatorRuntimeHttpClient } from '../../src/application/operator-runtime-http-client.js';

describe('OperatorRuntimeHttpClient', () => {
  const originalToken = process.env.SAIVAGE_API_TOKEN;
  afterEach(() => { if (originalToken === undefined) delete process.env.SAIVAGE_API_TOKEN; else process.env.SAIVAGE_API_TOKEN = originalToken; });

  it('uses the published disabled endpoint verbatim and omits authorization', async () => {
    process.env.SAIVAGE_API_TOKEN = 'ignored-secret';
    const request = jest.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: 'stopped', contained: false }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(new OperatorRuntimeHttpClient(request).stopProject({ origin: 'http://127.0.0.1:43117', auth: 'disabled' })).resolves.toEqual({ status: 'stopped', contained: false });
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:43117/api/runtime/stop-project', expect.objectContaining({ method: 'POST', headers: expect.not.objectContaining({ authorization: expect.anything() }) }));
  });

  it('requires and sends bearer credentials only as a header', async () => {
    delete process.env.SAIVAGE_API_TOKEN;
    const request = jest.fn<typeof fetch>();
    const client = new OperatorRuntimeHttpClient(request);
    await expect(client.stopProject({ origin: 'https://operator.example', auth: 'bearer' })).rejects.toThrow('Live service requires bearer authentication; set SAIVAGE_API_TOKEN.');
    expect(request).not.toHaveBeenCalled();
    process.env.SAIVAGE_API_TOKEN = 'secret';
    request.mockResolvedValue(new Response(JSON.stringify({ status: 'stopped', contained: true }), { status: 200 }));
    await client.stopProject({ origin: 'https://operator.example', auth: 'bearer' });
    expect(request.mock.calls[0]![0]).toBe('https://operator.example/api/runtime/stop-project');
    expect((request.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer secret');
  });

  it('rejects malformed success responses without fallback', async () => {
    const request = jest.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    await expect(new OperatorRuntimeHttpClient(request).stopProject({ origin: 'http://localhost:80', auth: 'disabled' })).rejects.toThrow('response did not match');
  });

  it('uses the canonical method and path for every delegated operation', async () => {
    const status = { runtime: 'stopped', currentCardId: null, started_at: '2026-07-18T00:00:00.000Z', restart_server_available: true, pid: process.pid, actorRuntime: { pauseMode: 'idle', cards: [], agents: [] } };
    const responses = [status, status, status, { status: 'stopped', contained: true }, { status: 'restart_scheduled' }];
    const request = jest.fn<typeof fetch>(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
    const client = new OperatorRuntimeHttpClient(request);
    const endpoint = { origin: 'http://127.0.0.1:49123', auth: 'disabled' as const };
    await client.getRuntimeStatus(endpoint);
    await client.pauseRuntime(endpoint);
    await client.resumeRuntime(endpoint);
    await client.stopProject(endpoint);
    await client.restartServer(endpoint);
    expect(request.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['http://127.0.0.1:49123/api/runtime/status', 'GET'],
      ['http://127.0.0.1:49123/api/runtime/pause', 'POST'],
      ['http://127.0.0.1:49123/api/runtime/resume', 'POST'],
      ['http://127.0.0.1:49123/api/runtime/stop-project', 'POST'],
      ['http://127.0.0.1:49123/api/runtime/restart-server', 'POST'],
    ]);
    expect(request.mock.calls[4]![1]?.body).toBe('{"confirmation":"RESTART SERVER"}');
    for (const call of request.mock.calls.slice(1, 4)) {
      expect(call[1]).not.toHaveProperty('body');
      expect(call[1]?.headers).not.toHaveProperty('content-type');
      expect(call[1]?.headers).toMatchObject({ accept: 'application/json' });
    }
    expect(request.mock.calls[4]![1]?.headers).toMatchObject({ accept: 'application/json', 'content-type': 'application/json' });
  });

  const directFailures: Array<[string, () => Promise<Response>, RegExp]> = [
    ['connection failure', () => Promise.reject(new Error('connect failed')), /connect failed/],
    ['malformed JSON', () => Promise.resolve(new Response('not-json', { status: 200 })), /malformed JSON/],
    ['authentication failure', () => Promise.resolve(new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 })), /unauthorized/],
    ['server failure without message', () => Promise.resolve(new Response(JSON.stringify({ code: 'bad' }), { status: 503 })), /HTTP 503/],
  ];
  it.each(directFailures)('fails %s directly without a second request or fallback', async (_name, response, expected) => {
    const request = jest.fn<typeof fetch>(response as typeof fetch);
    await expect(new OperatorRuntimeHttpClient(request).stopProject({ origin: 'http://127.0.0.1:49123', auth: 'disabled' })).rejects.toThrow(expected);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
