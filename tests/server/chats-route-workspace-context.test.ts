import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSendResponseSchema } from '../../src/contracts/operator-api-chats.js';
import { createTestRuntimeApplication, ensureTestSaivageConfig, loadTestConfig } from '../helpers/test-runtime-application.js';

const submit = jest.fn<(sessionId: string, input: { userContent: string; workspaceContext?: unknown }) => Promise<unknown>>();
const resolveAnalystSessionId = jest.fn<(id?: string) => string>();
const analystSessionId = 'analyst:global';
const analystSessionPath = encodeURIComponent(analystSessionId);

jest.unstable_mockModule('../../src/agents/session-ids.js', () => ({
  GLOBAL_ANALYST_SESSION_ID: analystSessionId,
  resolveAnalystSessionId,
  isSafeAgentSessionId: jest.fn(() => true),
  SAFE_AGENT_SESSION_ID_RE: /^[\w:.-]+$/,
}));

const { registerOperatorContractRoutes } = await import('../../src/server/routes/operator-contracts.js');

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's08-chat-route-'));
  mkdirSync(join(root, '.saivage'), { recursive: true });
  ensureTestSaivageConfig(root);
  return root;
}

describe('POST /api/chats/:sessionId workspaceContext', () => {
  let root: string;

  beforeEach(() => {
    root = setupRoot();
    submit.mockReset();
    resolveAnalystSessionId.mockReset();
    resolveAnalystSessionId.mockReturnValue(analystSessionId);
    submit.mockResolvedValue({
      sessionId: analystSessionId,
      message: { id: 'm1', role: 'assistant', kind: 'text', content: 'ok', timestamp: '2025-01-01T00:00:00Z' },
      toolInvocations: [],
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function app() {
    const fastify = Fastify();
    const runtimeApplication = createTestRuntimeApplication();
    Object.defineProperty(runtimeApplication, 'analystRuntime', { value: { submit, setRequestServerRestart: jest.fn() } });
    registerOperatorContractRoutes({ fastify, projectRoot: root, runtimeApplication, saivageConfig: loadTestConfig(root) });
    await fastify.ready();
    return fastify;
  }

  it('omits the third handleMessage argument when workspaceContext is absent', async () => {
    const fastify = await app();
    try {
      const response = await fastify.inject({ method: 'POST', url: `/api/chats/${analystSessionPath}`, payload: { content: 'hi' } });
      expect(response.statusCode).toBe(200);
      expect(ChatSendResponseSchema.parse(response.json())).toEqual({
        sessionId: analystSessionId,
        message: { id: 'm1', role: 'assistant', kind: 'text', content: 'ok', timestamp: '2025-01-01T00:00:00Z' },
        toolInvocations: [],
      });
      expect(submit).toHaveBeenCalledWith(analystSessionId, { userContent: 'hi', workspaceContext: undefined });
    } finally { await fastify.close(); }
  });

  it('forwards valid workspaceContext as the third handleMessage argument', async () => {
    const fastify = await app();
    const workspaceContext = { view: 'cards', entityId: 'code-3', refinement: null };
    try {
      const response = await fastify.inject({ method: 'POST', url: `/api/chats/${analystSessionPath}`, payload: { content: 'hi', workspaceContext } });
      expect(response.statusCode).toBe(200);
      expect(submit).toHaveBeenCalledWith(analystSessionId, { userContent: 'hi', workspaceContext });
    } finally { await fastify.close(); }
  });


  it('canonicalizes the analyst success body before contract response parsing', async () => {
    submit.mockResolvedValueOnce({
      sessionId: analystSessionId,
      message: { id: 'm-loose', content: 'canonical reply', timestamp: '2025-01-01T00:00:02Z', extra: 'preserved' },
    });
    const fastify = await app();
    try {
      const response = await fastify.inject({ method: 'POST', url: `/api/chats/${analystSessionPath}`, payload: { content: 'hi' } });
      expect(response.statusCode).toBe(200);
      expect(ChatSendResponseSchema.parse(response.json())).toEqual({
        sessionId: analystSessionId,
        message: { id: 'm-loose', role: 'assistant', kind: 'text', content: 'canonical reply', timestamp: '2025-01-01T00:00:02Z', extra: 'preserved' },
        toolInvocations: [],
      });
    } finally { await fastify.close(); }
  });

  it('rejects malformed workspaceContext with 400', async () => {
    const fastify = await app();
    try {
      const response = await fastify.inject({ method: 'POST', url: `/api/chats/${analystSessionPath}`, payload: { content: 'hi', workspaceContext: { view: 42, entityId: null, refinement: null } } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'ValidationError',
        message: 'chats.send body did not match the operator API contract',
        issues: expect.any(Array),
      });
      expect(submit).not.toHaveBeenCalled();
    } finally { await fastify.close(); }
  });

  it('rejects non-canonical chat session ids', async () => {
    const fastify = await app();
    try {
      const response = await fastify.inject({ method: 'POST', url: '/api/chats/chat-1', payload: { content: 'hi' } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Only the canonical analyst chat is available.', sessionId: 'chat-1' });
      expect(submit).not.toHaveBeenCalled();
    } finally { await fastify.close(); }
  });
});
