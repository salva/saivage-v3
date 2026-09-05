import { describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';
import { request } from 'node:http';
import { Writable } from 'node:stream';

import { serializeRequestForLog } from '../../src/server/request-log-serializer.js';

function get(url: URL, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { headers: { host } }, (response) => {
      response.resume();
      response.once('end', resolve);
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

describe('request logging', () => {
  it('logs standard request metadata with query-free URLs', async () => {
    const output: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output.push(chunk.toString());
        callback();
      },
    });
    const fastify = Fastify({
      logger: {
        level: 'info',
        stream,
        serializers: { req: serializeRequestForLog },
      },
    });
    let routedRequest: { url: string; query: unknown } | undefined;
    fastify.get('/socket', async (request) => {
      routedRequest = { url: request.url, query: request.query };
      return { ok: true };
    });
    fastify.get('/status/check', async () => ({ ok: true }));

    try {
      await fastify.listen({ host: '127.0.0.1', port: 0 });
      const address = fastify.server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected TCP server address');

      const ticketMarker = 'ticket-QUERY-MARKER';
      await get(new URL(`/socket?ticket=${ticketMarker}&query_marker=present`, `http://127.0.0.1:${address.port}`), 'operator.example');
      await get(new URL('/status/check', `http://127.0.0.1:${address.port}`), 'operator.example');

      const entries = output.flatMap((chunk) => chunk.split('\n')).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      const requestEntries = entries.filter((entry) => entry.msg === 'incoming request');
      expect(requestEntries).toHaveLength(2);

      const queryRequest = requestEntries[0] as { reqId: string; req: Record<string, unknown> };
      expect(JSON.stringify(queryRequest)).not.toContain(ticketMarker);
      expect(JSON.stringify(queryRequest)).not.toContain('query_marker');
      expect(queryRequest.req).toMatchObject({
        method: 'GET',
        url: '/socket',
        host: 'operator.example',
        remoteAddress: '127.0.0.1',
      });
      expect(queryRequest.reqId).toMatch(/^req-/);
      expect(queryRequest.req.remotePort).toEqual(expect.any(Number));
      expect(routedRequest).toEqual({
        url: `/socket?ticket=${ticketMarker}&query_marker=present`,
        query: { ticket: ticketMarker, query_marker: 'present' },
      });

      expect((requestEntries[1] as { req: Record<string, unknown> }).req.url).toBe('/status/check');
    } finally {
      await fastify.close();
    }
  });
});
