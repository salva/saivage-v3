import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { CardService } from '../../src/cards/card-api.js';
import { UnexpectedInternalServerErrorSchema } from '../../src/contracts/index.js';
import { appLogFile } from '../../src/persistence/layout.js';
import { AuthPolicy, type HttpAuthResult } from '../../src/server/auth-policy.js';
import { registerInternalDebugRoutes } from '../../src/server/routes/chats-files-debug.js';

type DirectHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('direct Doctor pre-send boundaries', () => {
  it('contains a hostile authentication throw locally', async () => {
    const path = '/api/debug/doctor'; const operation = 'debug.doctor'; const message = 'Operator Doctor operation failed';
    const marker = `hostile-auth-${operation}`;
    const root = malformedAppLogRoot();
    const store = { list: jest.fn(() => { throw new Error(`route-work-${marker}`); }) } as unknown as CardService;
    const authPolicy = new AuthPolicy();
    jest.spyOn(authPolicy, 'validateHttpRequest').mockImplementation(() => { throw hostileFailure(marker); });
    const { handlers, registrationOptions } = mountedDirectHandlers(root, store, authPolicy);
    const logError = jest.fn();
    const reply = capturingReply();

    await handlers.get(path)!(request(logError), reply.value);

    expect(registrationOptions.get(path)).toBeUndefined();
    expect(reply.status).toHaveBeenCalledTimes(1);
    expect(reply.send).toHaveBeenCalledTimes(1);
    expect(reply.status).toHaveBeenCalledWith(500);
    const body = reply.send.mock.calls[0]![0];
    expect(UnexpectedInternalServerErrorSchema.parse(body)).toEqual(body);
    expect(logError).toHaveBeenCalledWith({ operation, failureCode: 'auth_evaluation_failed' }, message);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(store.list).not.toHaveBeenCalled();
    expect(JSON.stringify({ body, logs: logError.mock.calls })).not.toContain(marker);
  });

  it.each([
    { name: 'missing', headers: {} as Record<string, string>, query: {} as Record<string, string> },
    { name: 'malformed', headers: { authorization: 'not-bearer' }, query: {} },
    { name: 'invalid', headers: { authorization: 'Bearer wrong' }, query: {} },
    { name: 'query token', headers: { authorization: 'Bearer direct-token' }, query: { token: 'forbidden' } },
  ])('preserves exact 401 without logs or route work for $name credentials', async ({ headers, query }) => {
    const root = malformedAppLogRoot();
    const store = { list: jest.fn(() => { throw new Error('Doctor route work must be skipped.'); }) } as unknown as CardService;
    const { handlers } = mountedDirectHandlers(root, store, new AuthPolicy({ apiToken: 'direct-token' }));

    for (const path of ['/api/debug/doctor']) {
      const logError = jest.fn();
      const reply = capturingReply();
      await handlers.get(path)!(request(logError, headers, query), reply.value);

      expect(reply.status).toHaveBeenCalledTimes(1);
      expect(reply.send).toHaveBeenCalledTimes(1);
      expect(reply.status).toHaveBeenCalledWith(401);
      expect(reply.send).toHaveBeenCalledWith({ error: 'Unauthorized', statusCode: 401 });
      expect(logError).not.toHaveBeenCalled();
    }
    expect(store.list).not.toHaveBeenCalled();
  });

  it('keeps a failed Doctor card check as a safe useful issues_found success', async () => {
    const marker = 'hostile-doctor-card-read';
    const store = { list: jest.fn(() => { throw hostileFailure(marker); }) } as unknown as CardService;
    const { handlers } = mountedDirectHandlers(emptyRoot(), store, admittedPolicy());
    const logError = jest.fn();
    const reply = capturingReply();

    await handlers.get('/api/debug/doctor')!(request(logError), reply.value);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledTimes(1);
    expect(reply.send).toHaveBeenCalledWith({
      status: 'issues_found',
      checks: [{ name: 'cards_loadable', passed: false, details: 'Cards failed to load.' }],
      issues: [{ severity: 'error', message: 'Cards failed to load.' }],
    });
    expect(logError).toHaveBeenCalledWith(
      { operation: 'debug.doctor', failureCode: 'cards_load_failed' },
      'Operator Doctor card check failed',
    );
    expect(JSON.stringify({ body: reply.send.mock.calls, logs: logError.mock.calls })).not.toContain(marker);
  });

  it('returns a strict safe 500 for a Doctor outer failure', async () => {
    const root = malformedAppLogRoot();
    const store = { list: jest.fn(() => { throw hostileFailure('doctor-inner'); }) } as unknown as CardService;
    const { handlers } = mountedDirectHandlers(root, store, admittedPolicy());

    const doctorLogs: unknown[][] = [];
    const doctorLog = jest.fn((...args: unknown[]) => {
      if (doctorLogs.length === 0) {
        doctorLogs.push(args);
        throw hostileFailure('doctor-log-throw');
      }
      doctorLogs.push(args);
    });
    const doctorReply = capturingReply();
    await handlers.get('/api/debug/doctor')!(request(doctorLog), doctorReply.value);
    expect(doctorReply.send).toHaveBeenCalledTimes(1);
    expect(UnexpectedInternalServerErrorSchema.safeParse(doctorReply.send.mock.calls[0]![0]).success).toBe(true);
    expect(doctorLogs[1]).toEqual([
      { operation: 'debug.doctor', failureCode: 'doctor_failed' },
      'Operator Doctor operation failed',
    ]);

  });

  it('preserves a successful Doctor projection with one send', async () => {
    const store = { list: jest.fn(() => []) } as unknown as CardService;
    const { handlers } = mountedDirectHandlers(emptyRoot(), store, admittedPolicy());

    const doctorReply = capturingReply();
    await handlers.get('/api/debug/doctor')!(request(jest.fn()), doctorReply.value);
    expect(doctorReply.status).toHaveBeenCalledWith(200);
    expect(doctorReply.send).toHaveBeenCalledTimes(1);
    expect(doctorReply.send).toHaveBeenCalledWith({
      status: 'ok',
      checks: [{ name: 'cards_loadable', passed: true, details: 'Cards loaded successfully.' }],
      issues: [],
    });

  });
});

function mountedDirectHandlers(projectRoot: string, store: CardService, authPolicy: AuthPolicy) {
  const handlers = new Map<string, DirectHandler>();
  const registrationOptions = new Map<string, unknown>();
  const get = jest.fn((path: string, handler: DirectHandler) => {
    handlers.set(path, handler);
    registrationOptions.set(path, undefined);
  });
  registerInternalDebugRoutes({ get } as unknown as FastifyInstance, projectRoot, store, authPolicy);
  return { handlers, registrationOptions };
}

function capturingReply() {
  const send = jest.fn<(body: unknown) => unknown>((body) => body);
  const status = jest.fn<(statusCode: number) => FastifyReply>();
  const value = { status, send } as unknown as FastifyReply;
  status.mockReturnValue(value);
  return { value, status, send };
}

function request(logError: jest.Mock, headers: Record<string, string> = {}, query: Record<string, string> = {}): FastifyRequest {
  return { headers, query, log: { error: logError } } as unknown as FastifyRequest;
}

function admittedPolicy(): AuthPolicy {
  const policy = new AuthPolicy();
  jest.spyOn(policy, 'validateHttpRequest').mockReturnValue({ ok: true, mode: 'disabled' } satisfies HttpAuthResult);
  return policy;
}

function hostileFailure(marker: string): Error {
  const failure = new Error(`message-${marker}`, { cause: { token: `cause-${marker}` } });
  failure.stack = `stack-${marker}`;
  Object.assign(failure, { token: `token-${marker}`, path: `/secret/${marker}`, toString: () => { throw new Error(`stringify-${marker}`); } });
  return failure;
}

function emptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-direct-debug-'));
  roots.push(root);
  return root;
}

function malformedAppLogRoot(): string {
  const root = emptyRoot();
  mkdirSync(dirname(appLogFile(root)), { recursive: true });
  writeFileSync(appLogFile(root), '{}\n');
  return root;
}
