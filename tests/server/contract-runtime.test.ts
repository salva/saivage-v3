import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { EventBus } from '../../src/events/index.js';

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
  response: { 200: SuccessSchema, 418: TeapotSchema, 500: InternalErrorSchema },
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
      reply: FastifyReply;
    }) => {
      parsedBody = body;
      reply.header('x-contract-reply', 'available');
      return { body: { seq: params.seq, from: query.from, rawBody: request.body } };
    });
    new ContractRuntime({ authPolicy: new AuthPolicy() }).mount(fastify, { transformed: contract }, { transformed: handler });

    const response = await fastify.inject({ method: 'POST', url: '/test/7?from=9', payload: { retained: true } });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-contract-reply']).toBe('available');
    expect(response.json()).toEqual({ seq: 7, from: 9, rawBody: { retained: true } });
    expect(parsedBody).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid request data before handler invocation', async () => {
    const handler = jest.fn(() => ({ body: { seq: 1, from: 1, rawBody: null } }));
    new ContractRuntime({ authPolicy: new AuthPolicy() }).mount(fastify, { transformed: contract }, { transformed: handler });

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
    expect(violation.json()).toEqual({ error: 'ContractViolation', message: 'test.transformed response did not match the operator API contract' });
    expect(actionableErrors).toEqual([
      expect.objectContaining({
        actionable_error: expect.objectContaining({
          code: 'contract_response_violation',
          currentState: expect.objectContaining({ operationId: 'test.transformed', statusCode: 200 }),
        }),
      }),
    ]);
  });
});
