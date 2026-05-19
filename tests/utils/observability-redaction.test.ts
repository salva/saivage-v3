import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, afterEach } from '@jest/globals';
import { EventLogger } from '../../src/utils/event-logger.js';
import { registerChatsFilesDebugRoutes } from '../../src/server/routes/chats-files-debug.js';

const roots: string[] = [];
const RAW_TOKEN = 'synthetic-token-value-49';
const RAW_API_KEY = 'synthetic-api-key-value-49';
const RAW_AUTH = 'Bearer synthetic-authorization-value-49';
const RAW_PASSWORD = 'synthetic-password-value-49';
const RAW_SECRET = 'synthetic-secret-value-49';

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-observability-redaction-'));
  roots.push(root);
  mkdirSync(join(root, '.saivage', 'runtime'), { recursive: true });
  return root;
}

function makeSaivageDir(): string {
  return join(makeProjectRoot(), '.saivage');
}

function providerErrorJsonText(): string {
  return JSON.stringify({
    token: RAW_TOKEN,
    api_key: RAW_API_KEY,
    authorization: RAW_AUTH,
    password: RAW_PASSWORD,
    secret: RAW_SECRET,
    safe: 'visible',
  });
}

function escapedProviderErrorJsonText(): string {
  return JSON.stringify(providerErrorJsonText());
}

function expectRedactedProviderError(serialized: string): void {
  expect(serialized).not.toContain(RAW_TOKEN);
  expect(serialized).not.toContain(RAW_API_KEY);
  expect(serialized).not.toContain(RAW_AUTH);
  expect(serialized).not.toContain(RAW_PASSWORD);
  expect(serialized).not.toContain(RAW_SECRET);
  expect(serialized).toContain('[REDACTED]');
  expect(serialized).toContain('visible');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('observability event redaction', () => {
  it('persists invocation_failed provider-error JSON with token/api_key/authorization values redacted', () => {
    const logger = new EventLogger(makeSaivageDir());
    logger.appendEvent({
      kind: 'invocation_failed',
      session_id: 'planner:redaction-test',
      role: 'planner',
      attempt: 1,
      error_message: `Provider failed: ${providerErrorJsonText()}`,
      provider_error: {
        detail: 'Synthetic provider error',
        token: RAW_TOKEN,
        api_key: RAW_API_KEY,
        authorization: RAW_AUTH,
        password: RAW_PASSWORD,
        secret: RAW_SECRET,
        nested: { accessToken: RAW_TOKEN, apiToken: RAW_API_KEY, password: RAW_PASSWORD, secret: RAW_SECRET, safe: 'visible' },
      },
    });

    const [event] = logger.getEvents({ kind: 'invocation_failed' });
    logger.close();

    expectRedactedProviderError(JSON.stringify(event));
  });

  it('redacts provider-like secrets embedded in stringified JSON fields before persistence', () => {
    const logger = new EventLogger(makeSaivageDir());
    logger.appendEvent({
      kind: 'invocation_failed',
      session_id: 'planner:stringified-redaction-test',
      role: 'planner',
      attempt: 1,
      error_message: `Provider failed with body ${escapedProviderErrorJsonText()}`,
      details: `Retry payload included ${escapedProviderErrorJsonText()}`,
    });

    const [event] = logger.getEvents({ kind: 'invocation_failed' });
    logger.close();

    expectRedactedProviderError(JSON.stringify(event));
    expect((event as unknown as { error_message: string }).error_message).toContain('Provider failed with body');
    expect((event as unknown as { details: string }).details).toContain('Retry payload included');
  });

  it('redacts stringified provider-error JSON from debug timeline and errors API responses', async () => {
    const projectRoot = makeProjectRoot();
    const runtimeDir = join(projectRoot, '.saivage', 'runtime');
    const errorEvent = {
      id: 'evt-stringified-error',
      timestamp: '2026-05-19T00:00:00.000Z',
      kind: 'invocation_failed',
      session_id: 'planner:api-redaction-test',
      error_message: `Provider failed with body ${escapedProviderErrorJsonText()}`,
      details: `Nested stringified body ${escapedProviderErrorJsonText()}`,
    };
    writeFileSync(join(runtimeDir, 'events.jsonl'), `${JSON.stringify(errorEvent)}\n`);
    writeFileSync(join(runtimeDir, 'errors.jsonl'), `${JSON.stringify(errorEvent)}\n`);

    const app: FastifyInstance = Fastify({ logger: false });
    registerChatsFilesDebugRoutes(app, projectRoot);
    await app.ready();

    const timeline = await app.inject({ method: 'GET', url: '/api/debug/timeline' });
    const errors = await app.inject({ method: 'GET', url: '/api/debug/errors' });
    await app.close();

    expect(timeline.statusCode).toBe(200);
    expect(errors.statusCode).toBe(200);
    expectRedactedProviderError(timeline.body);
    expectRedactedProviderError(errors.body);
  });
});
