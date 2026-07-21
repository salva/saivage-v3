import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { createEventLog } from '../../src/observability/index.js';
import { AppLogPublicationError, readAppLogEntries } from '../../src/persistence/app-log.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const contract = {
  operationId: 'test.response', method: 'GET', path: '/test', auth: 'public', successSchemaName: 'TestResponse',
  success: z.object({ ok: z.literal(true) }).strict(),
  error: z.object({ error: z.string(), message: z.string().optional() }).strict(),
  response: { 200: z.object({ ok: z.literal(true) }).strict(), 500: z.object({ error: z.string(), message: z.string().optional() }).strict() },
} as const;

describe('ContractRuntime app-log ownership', () => {
  it('appends an actionable error, then hints, then returns the existing contract failure', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'contract-runtime-log-')); roots.push(projectRoot);
    const trace: string[] = [];
    const eventLogger = createEventLog(projectRoot, () => { trace.push('hint'); });
    const fastify = Fastify({ logger: false });
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger }).mount(fastify, { operation: contract }, {
      operation: () => ({ body: { ok: false } }),
    });
    const response = await fastify.inject({ method: 'GET', url: '/test' });
    await fastify.close();

    expect(response.statusCode).toBe(500);
    const events = readAppLogEntries(projectRoot, 'event').map((entry) => entry.data);
    expect(events).toEqual([expect.objectContaining({ kind: 'runtime_actionable_error', actionable_error: expect.objectContaining({ code: 'contract_response_violation' }) })]);
    expect(trace).toEqual(['hint']);
  });

  it('rethrows the exact publication failure before ordinary contract normalization', async () => {
    let mounted: ((request: unknown, reply: unknown) => Promise<unknown>) | undefined;
    const fastify = { route: (route: { handler: typeof mounted }) => { mounted = route.handler; } } as unknown as FastifyInstance;
    const publicationCause = new Error('disk failed');
    const publicationError = new AppLogPublicationError('event', publicationCause);
    const eventLogger = { appendEventPrepared: jest.fn(() => { throw publicationError; }) } as never;
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger }).mount(fastify, { operation: contract }, {
      operation: () => ({ body: { ok: false } }),
    });
    const request = { params: {}, query: {}, headers: {}, log: { error: jest.fn() } };
    const reply = { status: jest.fn(() => ({ send: jest.fn() })), raw: { once: jest.fn() }, header: jest.fn() };
    await expect(mounted!(request, reply)).rejects.toBe(publicationError);
    expect(request.log.error).not.toHaveBeenCalled();
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('still normalizes unrelated handler failure to the fixed 500 response', async () => {
    const fastify = Fastify({ logger: false });
    const eventLogger = { appendEventPrepared: jest.fn() } as never;
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger }).mount(fastify, { operation: contract }, {
      operation: () => { throw new Error('ordinary failure'); },
    });
    const response = await fastify.inject({ method: 'GET', url: '/test' });
    await fastify.close();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
  });
});
