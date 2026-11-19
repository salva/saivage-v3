import { afterEach, expect, it, vi } from 'vitest';
import { gcWork } from '../api/client';
import { createServer } from 'node:http';
import { once } from 'node:events';

afterEach(() => vi.unstubAllGlobals());
const response = { mode: 'dry_run', disposition: 'refused', reason: 'maintenance_refused', restoration: 'not_acquired', failure: { code: 'EIO', syscall: 'read' }, result: null };
it('consumes the declared stream incrementally, reports progress, and waits for EOF', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  const request = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }));
  vi.stubGlobal('fetch', request);
  const observer = vi.fn();
  let settled = false;
  const call = gcWork({ mode: 'dry_run' }, undefined, observer).then(value => { settled = true; return value; });
  const progress = { phase: 'retention_marking', elapsed_ms: 0, observed_count: 0,
    first_global_protection: { reason: 'reference_scope_unknown', source: 'conversation_content' } };
  source.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'progress', progress }) + '\n'));
  await vi.waitFor(() => expect(observer).toHaveBeenCalledWith(progress));
  const terminal = new TextEncoder().encode(JSON.stringify({ type: 'result', response }) + '\n');
  source.enqueue(terminal.slice(0, 15)); source.enqueue(terminal.slice(15));
  await Promise.resolve(); expect(settled).toBe(false);
  source.close(); await expect(call).resolves.toEqual(response);
  expect(request).toHaveBeenCalledTimes(1);
});
it('sends a typed floor and decodes its conditional terminal retention count', async () => {
  const completed = { mode: 'dry_run', disposition: 'completed', reason: 'completed',
    restoration: 'not_resumed', failure: null, result: { mode: 'dry_run', observed_count: 1,
      observed_logical_bytes: 3, opaque_entries: 0, whole_work_size_known: false,
      first_global_protection: null, retained: { protected: 0, recent: 0, stale: 0, opaque: 0,
        target: 0, below_min_file_bytes: 1 }, would_delete_count: 0, would_delete_logical_bytes: 0,
      deleted_count: 0, deleted_logical_bytes: 0, expected_accounted_logical_bytes_remaining: 3,
      accounted_target_shortfall: null } };
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ type: 'result', response: completed }) + '\n',
    { headers: { 'content-type': 'application/x-ndjson' } }));
  vi.stubGlobal('fetch', request);
  const body = { mode: 'dry_run', min_file_bytes: 4 } as const;
  await expect(gcWork(body)).resolves.toEqual(completed);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify(body) }));
});
it.each(['application/json', 'application/x-ndjson'])('cancels invalid %s consumption and does not retry', async mime => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{}\n'));
  }, cancel });
  const request = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': mime } }));
  vi.stubGlobal('fetch', request);
  await expect(gcWork({ mode: 'dry_run' })).rejects.toThrow();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});

it('consumes real local HTTP chunks before completion, requiring terminal plus EOF', async () => {
  const nativeFetch = globalThis.fetch;
  let finish!: () => void;
  const end = new Promise<void>(resolve => { finish = resolve; });
  let observe!: () => void;
  const observed = new Promise<void>(resolve => { observe = resolve; });
  let sent!: () => void;
  const terminalSent = new Promise<void>(resolve => { sent = resolve; });
  const server = createServer(async (_request, reply) => {
    reply.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const line = JSON.stringify({ type: 'progress', progress: { phase: 'inventory', elapsed_ms: 0, first_global_protection: null } }) + '\n';
    for (const byte of new TextEncoder().encode(line)) reply.write(Uint8Array.of(byte));
    await observed;
    reply.write(JSON.stringify({ type: 'result', response }) + '\n'); sent();
    await end; reply.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const request = vi.fn((url: string, init?: RequestInit) => nativeFetch(`http://127.0.0.1:${address.port}${new URL(url, 'http://localhost').pathname}`, init));
  vi.stubGlobal('fetch', request);
  let settled = false;
  const call = gcWork({ mode: 'dry_run' }, undefined, value => {
    expect(value).toEqual({ phase: 'inventory', elapsed_ms: 0, first_global_protection: null }); observe();
  }).then(value => { settled = true; return value; });
  try {
    await Promise.race([terminalSent, call.then(() => { throw new Error('Premature completion'); })]); expect(settled).toBe(false);
    finish(); await expect(call).resolves.toEqual(response);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    observe(); finish(); await call.catch(() => undefined);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
