import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSendResponseSchema } from '../../src/contracts/operator-api-chats.js';
import { createTestRuntimeApplication } from '../helpers/test-active-runtime.js';

const handleMessage = jest.fn<(sessionId: string, content: string, workspaceContext?: unknown) => Promise<unknown>>();
const getOrCreateAnalystSession = jest.fn();

jest.unstable_mockModule('../../src/agents/analyst-handler.js', () => ({
  AnalystHandler: jest.fn().mockImplementation(() => ({ handleMessage })),
  GLOBAL_ANALYST_SESSION_ID: 'analyst',
  getAnalystHandler: jest.fn().mockImplementation(() => ({ handleMessage })),
  resetAnalystHandlerCache: jest.fn(),
  getOrCreateAnalystSession,
}));

const { registerOperatorContractRoutes } = await import('../../src/server/routes/operator-contracts.js');
const { resetChatRouteState } = await import('../../src/server/routes/chats-files-debug.js');

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's08-chat-route-'));
  mkdirSync(join(root, '.saivage'), { recursive: true });
  return root;
}

describe('POST /api/chats/:sessionId workspaceContext', () => {
  let root: string;

  beforeEach(() => {
    root = setupRoot();
    handleMessage.mockReset();
    getOrCreateAnalystSession.mockReset();
    getOrCreateAnalystSession.mockReturnValue({
      sessionId: 'analyst',
      session: { id: 'analyst', role: 'analyst', status: 'active', started_at: '2025-01-01T00:00:00Z' },
    });
    handleMessage.mockResolvedValue({
      sessionId: 'analyst',
      message: { id: 'm1', role: 'assistant', kind: 'text', content: 'ok', timestamp: '2025-01-01T00:00:00Z' },
      toolInvocations: [],
    });
    resetChatRouteState();
  });

  afterEach(() => {
    resetChatRouteState();
    rmSync(root, { recursive: true, force: true });
  });

  async function app() {
    const fastify = Fastify();
    registerOperatorContractRoutes({ fastify, projectRoot: root, runtimeApplication: createTestRuntimeApplication() });
    await fastify.ready();
    return fastify;
  }

  it('omits the third handleMessage argument when workspaceContext is absent', async () => {
    const fastify = await app();
    try {
      const response = await fastify.inject({ method: 'POST', url: '/api/chats/analyst', payload: { content: 'hi' } });
      expect(response.statusCode).toBe(200);
      expect(ChatSendResponseSchema.parse(response.json())).toEqual({
        sessionId: 'analyst',
        message: { id: 'm1', role: 'assistant', kind: 'text', content: 'ok', timestamp: '2025-01-01T00:00:00Z' },
        toolInvocations: [],
      });
      expect(handleMessage).toHaveBeenCalledWith('analyst', 'hi', undefined);
    } finally { await fastify.close(); }
  });

  it('forwards valid workspaceContext as the third handleMessage argument', async () => {
    const fastify = await app();
    const workspaceContext = { view: 'cards', entityId: 'code-3', refinement: null };
    try {
      const response = await fastify.inject({ method: 'POST', url: '/api/chats/analyst', payload: { content: 'hi', workspaceContext } });
      expect(response.statusCode).toBe(200);
      expect(handleMessage).toHaveBeenCalledWith('analyst', 'hi', workspaceContext);
    } finally { await fastify.close(); }
  });


  it('canonicalizes the analyst success body before contract response parsing', async () => {
    handleMessage.mockResolvedValueOnce({
      sessionId: 'analyst',
      message: { id: 'm-loose', content: 'canonical reply', timestamp: '2025-01-01T00:00:02Z', extra: 'preserved' },
    });
    const fastify = await app();
    try {
      const response = await fastify.inject({ method: 'POST', url: '/api/chats/analyst', payload: { content: 'hi' } });
      expect(response.statusCode).toBe(200);
      expect(ChatSendResponseSchema.parse(response.json())).toEqual({
        sessionId: 'analyst',
        message: { id: 'm-loose', role: 'assistant', kind: 'text', content: 'canonical reply', timestamp: '2025-01-01T00:00:02Z', extra: 'preserved' },
        toolInvocations: [],
      });
    } finally { await fastify.close(); }
  });

  it('rejects malformed workspaceContext with 400', async () => {
    const fastify = await app();
    try {
      const response = await fastify.inject({ method: 'POST', url: '/api/chats/analyst', payload: { content: 'hi', workspaceContext: { view: 42, entityId: null, refinement: null } } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'workspaceContext.view must be a string or null.' });
      expect(handleMessage).not.toHaveBeenCalled();
    } finally { await fastify.close(); }
  });

  it('rejects non-canonical chat session ids', async () => {
    const fastify = await app();
    try {
      const response = await fastify.inject({ method: 'POST', url: '/api/chats/chat-1', payload: { content: 'hi' } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Only the canonical analyst chat is available.', sessionId: 'chat-1' });
      expect(handleMessage).not.toHaveBeenCalled();
    } finally { await fastify.close(); }
  });
});
