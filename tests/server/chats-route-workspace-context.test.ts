import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const handleMessage = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule('../../src/agents/analyst-handler.js', () => ({
  AnalystHandler: jest.fn().mockImplementation(() => ({ handleMessage })),
  getAnalystHandler: jest.fn().mockImplementation(() => ({ handleMessage })),
  resetAnalystHandlerCache: jest.fn(),
  getOrCreateAnalystSession: jest.fn(),
}));

const { registerChatsFilesDebugRoutes, resetChatRouteState } = await import('../../src/server/routes/chats-files-debug.js');

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
    handleMessage.mockResolvedValue({
      sessionId: 'chat-1',
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
    registerChatsFilesDebugRoutes(fastify, root);
    await fastify.ready();
    return fastify;
  }

  it('omits the third handleMessage argument when workspaceContext is absent', async () => {
    const fastify = await app();
    try {
      const response = await fastify.inject({ method: 'POST', url: '/api/chats/chat-1', payload: { content: 'hi' } });
      expect(response.statusCode).toBe(200);
      expect(handleMessage).toHaveBeenCalledWith('chat-1', 'hi', undefined);
    } finally { await fastify.close(); }
  });

  it('forwards valid workspaceContext as the third handleMessage argument', async () => {
    const fastify = await app();
    const workspaceContext = { view: 'cards', entityId: 'code-3', refinement: null };
    try {
      const response = await fastify.inject({ method: 'POST', url: '/api/chats/chat-1', payload: { content: 'hi', workspaceContext } });
      expect(response.statusCode).toBe(200);
      expect(handleMessage).toHaveBeenCalledWith('chat-1', 'hi', workspaceContext);
    } finally { await fastify.close(); }
  });

  it('rejects malformed workspaceContext with 400', async () => {
    const fastify = await app();
    try {
      const response = await fastify.inject({ method: 'POST', url: '/api/chats/chat-1', payload: { content: 'hi', workspaceContext: { view: 42, entityId: null, refinement: null } } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'workspaceContext.view must be a string or null.' });
      expect(handleMessage).not.toHaveBeenCalled();
    } finally { await fastify.close(); }
  });
});
