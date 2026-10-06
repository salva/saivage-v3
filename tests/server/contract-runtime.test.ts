import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { createEventLog } from '../../src/observability/index.js';
import { readAppLogEntries } from '../../src/persistence/app-log.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { UnauthorizedErrorSchema } from '../../src/contracts/operator-api-core.js';
import { agentOperatorApiContracts } from '../../src/contracts/operator-api-agents.js';
import { runtimeCardsOperatorApiContracts } from '../../src/contracts/operator-api-runtime-cards.js';
import { ConversationSessionIdSchema, cardIdSchema } from '../../src/schemas/index.js';
import { testApplicationFatalDelivery, testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const contract = {
  operationId: 'test.response', method: 'GET', path: '/test', auth: 'public',
  success: z.object({ ok: z.literal(true) }).strict(),
  response: { 200: z.object({ ok: z.literal(true) }).strict(), 500: z.object({ error: z.string(), message: z.string().optional() }).strict() },
} as const;

describe('ContractRuntime app-log ownership', () => {
  it('skips AuthPolicy for a public contract', async () => {
    const fastify = Fastify({ logger: false });
    const authPolicy = new AuthPolicy({ apiToken: 'required-token' });
    const validate = jest.spyOn(authPolicy, 'validateHttpRequest');
    new ContractRuntime({ authPolicy, eventLogger: { appendEventPrepared: jest.fn() } as never, fatalPort: testApplicationFatalPort }).mount(fastify, { operation: contract }, {
      operation: () => ({ body: { ok: true } }),
    });

    const response = await fastify.inject({ method: 'GET', url: '/test' });
    await fastify.close();

    expect(response.statusCode).toBe(200);
    expect(validate).not.toHaveBeenCalled();
  });

  it('uses AuthPolicy for an operator-session contract and preserves 401 denial', async () => {
    const fastify = Fastify({ logger: false });
    const authPolicy = new AuthPolicy({ apiToken: 'required-token' });
    const validate = jest.spyOn(authPolicy, 'validateHttpRequest');
    const handler = jest.fn(() => ({ body: { ok: true } }));
    const operatorContract = { ...contract, auth: 'operator-session' as const, response: { ...contract.response, 401: UnauthorizedErrorSchema } };
    new ContractRuntime({ authPolicy, eventLogger: { appendEventPrepared: jest.fn() } as never, fatalPort: testApplicationFatalPort }).mount(fastify, { operation: operatorContract }, { operation: handler });

    const response = await fastify.inject({ method: 'GET', url: '/test' });
    await fastify.close();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'Unauthorized' });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('appends an actionable error and returns the existing contract failure', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'contract-runtime-log-')); roots.push(projectRoot);
    const eventLogger = createEventLog(projectRoot);
    const fastify = Fastify({ logger: false });
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger, fatalPort: testApplicationFatalPort }).mount(fastify, { operation: contract }, {
      operation: () => ({ body: { ok: false } }),
    });
    const response = await fastify.inject({ method: 'GET', url: '/test' });
    await fastify.close();

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
    const events = readAppLogEntries(projectRoot, 'event').map((entry) => entry.data);
    expect(events).toEqual([expect.objectContaining({ kind: 'runtime_actionable_error', actionable_error: expect.objectContaining({ code: 'contract_response_violation' }) })]);
  });

  it.each<[string, number, unknown]>([
    ['success-like', 201, { ok: true }],
    ['error-like', 404, { error: 'not found' }],
    ['schema-less', 204, undefined],
  ])('rejects an undeclared %s status without success/error fallback', async (_kind, statusCode, body) => {
    const fastify = Fastify({ logger: false });
    const appendEventPrepared = jest.fn();
    new ContractRuntime({
      authPolicy: new AuthPolicy(),
      eventLogger: { appendEventPrepared } as never,
      fatalPort: testApplicationFatalPort,
    }).mount(fastify, { operation: contract }, {
      operation: () => ({ statusCode, body }),
    });

    const response = await fastify.inject({ method: 'GET', url: '/test' });
    await fastify.close();

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
    expect(appendEventPrepared).toHaveBeenCalledTimes(1);
    const buildEvent = appendEventPrepared.mock.calls[0]![0] as () => unknown;
    expect(buildEvent()).toEqual(expect.objectContaining({
      kind: 'runtime_actionable_error',
      actionable_error: expect.objectContaining({
        code: 'contract_response_violation',
        currentState: expect.objectContaining({ statusCode }),
      }),
    }));
  });

  it('rethrows the exact publication failure before ordinary contract normalization', async () => {
    let mounted: ((request: unknown, reply: unknown) => Promise<unknown>) | undefined;
    const fastify = { route: (route: { handler: typeof mounted }) => { mounted = route.handler; } } as unknown as FastifyInstance;
    const publicationCause = new Error('disk failed');
    const publicationError = new PublicationOutcomeUnknownError();
    const eventLogger = { appendEventPrepared: jest.fn(() => { throw publicationError; }) } as never;
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger, fatalPort: testApplicationFatalPort }).mount(fastify, { operation: contract }, {
      operation: () => ({ body: { ok: false } }),
    });
    const request = { params: {}, query: {}, headers: {}, log: { error: jest.fn() } };
    const reply = { status: jest.fn(() => ({ send: jest.fn() })), raw: { once: jest.fn() }, header: jest.fn() };
    await expect(mounted!(request, reply)).rejects.toBe(testApplicationFatalDelivery);
    expect(request.log.error).not.toHaveBeenCalled();
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('still normalizes unrelated handler failure to the fixed 500 response', async () => {
    const fastify = Fastify({ logger: false });
    const eventLogger = { appendEventPrepared: jest.fn() } as never;
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger, fatalPort: testApplicationFatalPort }).mount(fastify, { operation: contract }, {
      operation: () => { throw new Error('ordinary failure'); },
    });
    const response = await fastify.inject({ method: 'GET', url: '/test' });
    await fastify.close();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
  });

  it('logs only allowlisted fields while preserving the fixed 500 response', async () => {
    let mounted: ((request: unknown, reply: unknown) => Promise<unknown>) | undefined;
    const fastify = { route: (route: { handler: typeof mounted }) => { mounted = route.handler; } } as unknown as FastifyInstance;
    const failure = new Error('secret-error-sentinel', { cause: new Error('secret-cause-sentinel') });
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger: { appendEventPrepared: jest.fn() } as never, fatalPort: testApplicationFatalPort }).mount(fastify, { operation: contract }, {
      operation: () => { throw failure; },
    });
    const error = jest.fn();
    const send = jest.fn();
    const status = jest.fn((_statusCode: number) => ({ send }));

    await mounted!({ params: {}, query: {}, headers: {}, log: { error } }, { status, raw: { once: jest.fn() }, header: jest.fn() });

    expect(error).toHaveBeenCalledWith(
      { operation: 'test.response', failureCode: 'handler_failed' },
      'Operator contract operation failed',
    );
    expect(status).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledWith({ error: 'InternalServerError', message: 'Internal server error' });
    expect(JSON.stringify([error.mock.calls, send.mock.calls])).not.toContain('sentinel');
  });

  const identityCases = [
    { route: runtimeCardsOperatorApiContracts['cards.get'], id: 'card-a', key: 'cardId', schema: cardIdSchema },
    { route: agentOperatorApiContracts['agents.detail'], id: 'agent:planner:card-a', key: 'sessionId', schema: ConversationSessionIdSchema },
  ] as const;

  it.each(identityCases)('copies admitted $key before handler mutation and excludes secret data', async ({ route, id, key }) => {
    let mounted: ((request: unknown, reply: unknown) => Promise<unknown>) | undefined;
    const fastify = { route: (value: { handler: typeof mounted }) => { mounted = value.handler; } } as unknown as FastifyInstance;
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger: { appendEventPrepared: jest.fn() } as never, fatalPort: testApplicationFatalPort }).mount(fastify, { operation: route }, {
      operation: ({ params }) => {
        (params as { id: string }).id = 'mutated-id-sentinel';
        throw new Error('secret-error-sentinel', { cause: new Error('secret-cause-sentinel') });
      },
    });
    const error = jest.fn();
    const send = jest.fn();
    const status = jest.fn(() => ({ send }));
    await mounted!({ params: { id }, query: { secret: 'secret-query-sentinel' }, body: { secret: 'secret-body-sentinel' }, headers: {}, url: '/secret-url-sentinel', log: { error } }, { status, raw: { once: jest.fn() }, header: jest.fn() });

    expect(error.mock.calls).toEqual([[
      { operation: route.operationId, failureCode: 'handler_failed', [key]: id },
      'Operator contract operation failed',
    ]]);
    expect(status.mock.calls).toEqual([[500]]);
    expect(send.mock.calls).toEqual([[{ error: 'InternalServerError', message: 'Internal server error' }]]);
    expect(JSON.stringify([error.mock.calls, send.mock.calls])).not.toContain('sentinel');
  });

  it.each(identityCases)('admits canonical $key without calling its public parse again', async ({ route, id, schema }) => {
    const parse = jest.spyOn(schema, 'parse');
    const fastify = Fastify({ logger: false });
    const handler = jest.fn(() => { throw new Error('ordinary failure'); });
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger: { appendEventPrepared: jest.fn() } as never, fatalPort: testApplicationFatalPort }).mount(fastify, { operation: route }, { operation: handler });
    const response = await fastify.inject({ method: 'GET', url: route.path.replace(':id', encodeURIComponent(id)) });
    await fastify.close();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(parse).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
  });

  it.each(identityCases)('rejects a malformed canonical $key before invoking the handler', async ({ route }) => {
    const fastify = Fastify({ logger: false });
    const handler = jest.fn(() => ({ body: { ok: true } }));
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger: { appendEventPrepared: jest.fn() } as never, fatalPort: testApplicationFatalPort }).mount(fastify, { operation: route }, { operation: handler });
    const response = await fastify.inject({ method: 'GET', url: route.path.replace(':id', 'invalid-id') });
    await fastify.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(expect.objectContaining({ error: 'ValidationError' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('authenticates before parsing malformed canonical params', async () => {
    const route = agentOperatorApiContracts['agents.detail'];
    const parse = jest.spyOn(route.params, 'safeParse');
    const handler = jest.fn(() => ({ body: { ok: true } }));
    const fastify = Fastify({ logger: false });
    new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'required-token' }), eventLogger: { appendEventPrepared: jest.fn() } as never, fatalPort: testApplicationFatalPort }).mount(fastify, { operation: route }, { operation: handler });
    const response = await fastify.inject({ method: 'GET', url: '/api/agents/invalid-id' });
    await fastify.close();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized', statusCode: 401 });
    expect(parse).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['query', 'body'] as const)('does not capture identity when %s admission throws after valid params', async (target) => {
    let mounted: ((request: unknown, reply: unknown) => Promise<unknown>) | undefined;
    const fastify = { route: (value: { handler: typeof mounted }) => { mounted = value.handler; } } as unknown as FastifyInstance;
    const route = {
      ...runtimeCardsOperatorApiContracts['cards.get'],
      [target]: z.object({ secret: z.string() }).transform(() => { throw new Error('secret-transform-sentinel'); }),
    };
    const handler = jest.fn(() => ({ body: { ok: true } }));
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger: { appendEventPrepared: jest.fn() } as never, fatalPort: testApplicationFatalPort }).mount(fastify, { operation: route }, { operation: handler });
    const error = jest.fn();
    const send = jest.fn();
    const status = jest.fn(() => ({ send }));
    await mounted!({ params: { id: 'card-a' }, query: { secret: 'secret-query-sentinel' }, body: { secret: 'secret-body-sentinel' }, headers: {}, log: { error } }, { status, raw: { once: jest.fn() }, header: jest.fn() });

    expect(handler).not.toHaveBeenCalled();
    expect(error.mock.calls).toEqual([[
      { operation: 'cards.get', failureCode: 'request_validation_failed' },
      'Operator contract operation failed',
    ]]);
    expect(status.mock.calls).toEqual([[500]]);
    expect(send.mock.calls).toEqual([[{ error: 'InternalServerError', message: 'Internal server error' }]]);
    expect(JSON.stringify([error.mock.calls, send.mock.calls])).not.toContain('sentinel');
  });
});
