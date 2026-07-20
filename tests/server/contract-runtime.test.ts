import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime, type ContractHandlerResult, type ContractPreSendReply } from '../../src/server/contract-runtime.js';
import { EventBus } from '../../src/events/index.js';
import {
  UNEXPECTED_INTERNAL_SERVER_ERROR,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from '../../src/contracts/index.js';

const SuccessSchema = z.object({ seq: z.number(), from: z.number(), rawBody: z.unknown() }).strict();
const TeapotSchema = z.object({ error: z.literal('teapot') }).strict();
const InternalErrorSchema = z.object({ error: z.string(), message: z.string().optional() }).strict();
const contract = {
  operationId: 'test.transformed',
  method: 'POST',
  path: '/test/:seq',
  params: z.object({ seq: z.string().regex(/^\d+$/).transform(Number) }),
  query: z.object({ from: z.string().regex(/^\d+$/).transform(Number) }),
  success: SuccessSchema,
  error: InternalErrorSchema,
  response: { 200: SuccessSchema, 400: z.unknown(), 418: TeapotSchema, 500: InternalErrorSchema },
  auth: 'public',
  successSchemaName: 'TestSuccess',
} as const;

describe('ContractRuntime parsed request context', () => {
  let fastify: FastifyInstance;

  beforeEach(() => {
    fastify = Fastify({ logger: false });
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('passes transformed values with the raw request and reply to the handler', async () => {
    let parsedBody: undefined;
    const handler = jest.fn(({ params, query, body, request, reply }: {
      params: { seq: number };
      query: { from: number };
      body: undefined;
      request: FastifyRequest;
      reply: ContractPreSendReply;
    }) => {
      parsedBody = body;
      reply.header('x-contract-reply', 'available');
      return { body: { seq: params.seq, from: query.from, rawBody: request.body } };
    });
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventBus: new EventBus() }).mount(fastify, { transformed: contract }, { transformed: handler });

    const response = await fastify.inject({ method: 'POST', url: '/test/7?from=9', payload: { retained: true } });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-contract-reply']).toBe('available');
    expect(response.json()).toEqual({ seq: 7, from: 9, rawBody: { retained: true } });
    expect(parsedBody).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid request data before handler invocation', async () => {
    const handler = jest.fn(() => ({ body: { seq: 1, from: 1, rawBody: null } }));
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventBus: new EventBus() }).mount(fastify, { transformed: contract }, { transformed: handler });

    const response = await fastify.inject({ method: 'POST', url: '/test/not-a-number?from=9' });

    expect(response.statusCode).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it('emits declared non-200 responses unchanged and converts invalid outbound bodies to 500', async () => {
    let invalid = false;
    const eventBus = new EventBus();
    const actionableErrors: unknown[] = [];
    eventBus.subscribe('runtime_actionable_error', (event) => { actionableErrors.push(event.payload); });
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventBus }).mount(fastify, { transformed: contract }, {
      transformed: () => invalid
        ? { body: { seq: 'wrong', from: 9, rawBody: null } }
        : { statusCode: 418, body: { error: 'teapot' } },
    });

    const teapot = await fastify.inject({ method: 'POST', url: '/test/7?from=9' });
    expect(teapot.statusCode).toBe(418);
    expect(teapot.json()).toEqual({ error: 'teapot' });

    invalid = true;
    const violation = await fastify.inject({ method: 'POST', url: '/test/7?from=9' });
    expect(violation.statusCode).toBe(500);
    expect(violation.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
    expect(actionableErrors).toEqual([
      expect.objectContaining({
        actionable_error: expect.objectContaining({
          code: 'contract_response_violation',
          currentState: expect.objectContaining({ operation: 'test.transformed', statusCode: 200 }),
        }),
      }),
    ]);
  });
});

type CapturedRouteHandler = (request: any, reply: any) => Promise<unknown>;

function hostileFailure(marker: string): Error {
  const error = new Error(`message-${marker}`, { cause: `cause-${marker}` });
  error.stack = `stack-${marker}`;
  Object.assign(error, { token: `token-${marker}`, path: `/secret/${marker}`, custom: marker });
  error.toString = () => `string-${marker}`;
  return error;
}

function runtimeHarness(options: {
  contract: OperatorRouteContract;
  handler?: () => ContractHandlerResult | Promise<ContractHandlerResult>;
  authPolicy?: AuthPolicy;
  eventBus?: EventBus;
}) {
  let routeHandler: CapturedRouteHandler | undefined;
  const fastify = {
    route(route: { handler: CapturedRouteHandler }) { routeHandler = route.handler; },
  } as unknown as FastifyInstance;
  const eventBus = options.eventBus ?? new EventBus();
  const handler = jest.fn(options.handler ?? (() => ({ body: { ok: true } })));
  new ContractRuntime({ authPolicy: options.authPolicy ?? new AuthPolicy(), eventBus }).mount(
    fastify,
    { operation: options.contract },
    { operation: handler },
  );
  const error = jest.fn();
  const send = jest.fn((body: unknown) => body);
  const status = jest.fn((_statusCode: number) => ({ send }));
  const request = {
    params: { id: 'planner:project' },
    query: {},
    body: undefined,
    headers: {},
    log: { error },
  };
  const invoke = async () => {
    if (!routeHandler) throw new Error('Route was not mounted.');
    await routeHandler(request, { status, raw: { once: jest.fn() }, header: jest.fn() });
    return { statusCode: status.mock.calls[0]?.[0], body: send.mock.calls[0]?.[0] };
  };
  return { invoke, request, eventBus, error, status, send, handler };
}

const StrictSuccessSchema = z.object({ ok: z.literal(true) }).strict();
const Strict500Schema = UnexpectedInternalServerErrorSchema;

function phaseContract(overrides: Partial<OperatorRouteContract> = {}): OperatorRouteContract {
  return {
    operationId: 'test.phase',
    method: 'GET',
    path: '/phase/:id',
    params: z.object({ id: z.string() }),
    success: StrictSuccessSchema,
    error: Strict500Schema,
    response: { 200: StrictSuccessSchema, 400: z.unknown(), 401: z.unknown(), 403: z.unknown(), 500: Strict500Schema },
    auth: 'public',
    successSchemaName: 'StrictSuccess',
    ...overrides,
  };
}

describe('ContractRuntime complete pre-send failure boundary', () => {
  it.each([
    {
      phase: 'auth evaluation',
      failureCode: 'auth_evaluation_failed',
      expectedHandlerCalls: 0,
      setup: () => {
        const authPolicy = new AuthPolicy({ apiToken: 'expected' });
        jest.spyOn(authPolicy, 'validateHttpRequest').mockImplementation(() => { throw hostileFailure('auth'); });
        return runtimeHarness({ contract: phaseContract({ auth: 'operator-session' }), authPolicy });
      },
    },
    {
      phase: 'request validation execution',
      failureCode: 'request_validation_failed',
      expectedHandlerCalls: 0,
      setup: () => runtimeHarness({
        contract: phaseContract({ params: z.object({ id: z.string().transform(() => { throw hostileFailure('request'); }) }) }),
      }),
    },
    {
      phase: 'identity projection',
      failureCode: 'failure_identity_projection_failed',
      expectedHandlerCalls: 0,
      setup: () => runtimeHarness({
        contract: phaseContract({ failureIdentity: { kind: 'session', parameter: 'id' } }),
      }),
      prepare: (harness: ReturnType<typeof runtimeHarness>) => { harness.request.params.id = 'token-identity-/secret/'; },
    },
    {
      phase: 'permission evaluation',
      failureCode: 'permission_evaluation_failed',
      expectedHandlerCalls: 0,
      setup: () => runtimeHarness({
        contract: phaseContract({ permissions: () => { throw hostileFailure('permission'); } }),
      }),
    },
    {
      phase: 'handler execution',
      failureCode: 'handler_failed',
      expectedHandlerCalls: 1,
      setup: () => runtimeHarness({ contract: phaseContract(), handler: () => { throw hostileFailure('handler'); } }),
    },
    {
      phase: 'response schema execution',
      failureCode: 'response_validation_failed',
      expectedHandlerCalls: 1,
      setup: () => runtimeHarness({
        contract: phaseContract({ response: { 200: { safeParse: () => { throw hostileFailure('response-schema'); } } as unknown as z.ZodTypeAny, 500: Strict500Schema } }),
      }),
    },
    {
      phase: 'contract violation publication',
      failureCode: 'contract_violation_event_failed',
      expectedHandlerCalls: 1,
      setup: () => {
        const eventBus = new EventBus();
        jest.spyOn(eventBus, 'emit').mockImplementation(() => { throw hostileFailure('violation-publication'); });
        return runtimeHarness({ contract: phaseContract(), handler: () => ({ body: { ok: false } }), eventBus });
      },
    },
    {
      phase: 'audit publication',
      failureCode: 'audit_publication_failed',
      expectedHandlerCalls: 1,
      setup: () => {
        const eventBus = new EventBus();
        jest.spyOn(eventBus, 'emit').mockImplementation(() => { throw hostileFailure('audit-publication'); });
        return runtimeHarness({ contract: phaseContract({ audit: { kind: 'control_action_recorded' } }), eventBus });
      },
    },
  ])('returns and logs the strict failure for $phase', async ({ failureCode, expectedHandlerCalls, setup, prepare }) => {
    const harness = setup();
    prepare?.(harness);

    const response = await harness.invoke();

    expect(response).toEqual({ statusCode: 500, body: UNEXPECTED_INTERNAL_SERVER_ERROR });
    expect(UnexpectedInternalServerErrorSchema.safeParse(response.body).success).toBe(true);
    expect(harness.error).toHaveBeenCalledWith(
      { operation: 'test.phase', failureCode },
      'Operator contract operation failed',
    );
    expect(JSON.stringify(harness.error.mock.calls)).not.toMatch(/message-|stack-|cause-|token-|\/secret\/|string-/);
    expect(harness.status).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.handler).toHaveBeenCalledTimes(expectedHandlerCalls);
    if (failureCode === 'contract_violation_event_failed' || failureCode === 'audit_publication_failed') {
      expect(harness.eventBus.emit).toHaveBeenCalledTimes(1);
    }
  });

  it('publishes fixed response-violation evidence and logs response validation without response details', async () => {
    const eventBus = new EventBus();
    const publications: unknown[] = [];
    eventBus.subscribe('runtime_actionable_error', (event) => { publications.push(event.payload); });
    const harness = runtimeHarness({ contract: phaseContract(), handler: () => ({ body: { hostile: 'response-marker' } }), eventBus });

    expect(await harness.invoke()).toEqual({ statusCode: 500, body: UNEXPECTED_INTERNAL_SERVER_ERROR });
    expect(publications).toEqual([{
      actionable_error: {
        code: 'contract_response_violation',
        message: 'Operator contract response validation failed.',
        nextAction: 'Fix the route handler to return the declared contract response shape.',
        currentState: { operation: 'test.phase', statusCode: 200, failureCode: 'response_validation_failed' },
      },
    }]);
    expect(harness.error).toHaveBeenCalledWith(
      { operation: 'test.phase', failureCode: 'response_validation_failed' },
      'Operator contract operation failed',
    );
    expect(JSON.stringify([publications, harness.error.mock.calls])).not.toContain('response-marker');
  });

  it('preserves ordinary 401, 400, and 403 decisions with one send and no unexpected-failure log', async () => {
    const deniedAuth = runtimeHarness({ contract: phaseContract({ auth: 'operator-session' }), authPolicy: new AuthPolicy({ apiToken: 'expected' }) });
    const invalidRequest = runtimeHarness({ contract: phaseContract() });
    invalidRequest.request.params.id = 42 as unknown as string;
    const deniedPermission = runtimeHarness({ contract: phaseContract({ permissions: () => ({ allowed: false, reason: 'denied' }) }) });

    for (const [harness, statusCode] of [[deniedAuth, 401], [invalidRequest, 400], [deniedPermission, 403]] as const) {
      expect((await harness.invoke()).statusCode).toBe(statusCode);
      expect(harness.error).not.toHaveBeenCalled();
      expect(harness.send).toHaveBeenCalledTimes(1);
    }
  });

  it('adds only canonical session/card identity after parsing and never logs an invalid request value', async () => {
    const canonical = runtimeHarness({
      contract: phaseContract({ failureIdentity: { kind: 'session', parameter: 'id' } }),
      handler: () => { throw hostileFailure('canonical-handler'); },
    });
    await canonical.invoke();
    expect(canonical.error).toHaveBeenCalledWith(
      { operation: 'test.phase', failureCode: 'handler_failed', sessionId: 'planner:project' },
      'Operator contract operation failed',
    );

    const canonicalCard = runtimeHarness({
      contract: phaseContract({ failureIdentity: { kind: 'card', parameter: 'id' } }),
      handler: () => { throw hostileFailure('canonical-card-handler'); },
    });
    canonicalCard.request.params.id = 'project';
    await canonicalCard.invoke();
    expect(canonicalCard.error).toHaveBeenCalledWith(
      { operation: 'test.phase', failureCode: 'handler_failed', cardId: 'project' },
      'Operator contract operation failed',
    );

    const invalid = runtimeHarness({ contract: phaseContract({ failureIdentity: { kind: 'session', parameter: 'id' } }) });
    invalid.request.params.id = 'not-a-session';
    await invalid.invoke();
    expect(JSON.stringify(invalid.error.mock.calls)).not.toContain('not-a-session');
  });
});
