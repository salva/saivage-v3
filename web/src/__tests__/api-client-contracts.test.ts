import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '../api/client';
import { AnalystTurnBusyErrorSchema, parseOperatorResponse, type ConversationSessionId, type OperatorApiSuccess } from '../api/contracts';
import type { CardChildrenResponse, ChatResponse, McpToolsResponse, RuntimeStateResponse } from '../api/types';
import { API_AUTH_REQUIRED_EVENT } from '../utils/auth-events';

const removedMutationExports = [
  'createCard',
  'updateCard',
  'deleteCard',
  'startProject',
  'freezeRuntime',
  'resumeRuntimeFromFreeze',
  'acknowledgeNote',
  'deleteNote',
  'clearAllNotes',
  'acknowledgeNotification',
  'terminateProcess',
  'pauseRuntime',
  'resumeRuntime',
] as const;

const preservedReadAndBoundedWriteExports = [
  'getCardChildren',
  'getCard',
  'listCardRecords',
  'getCardRecord',
  'getRuntimeState',
  'getRuntimeStatus',
  'stopProject',
  'restartServer',
  'issueWebSocketTicket',
  'sendChatMessage',
] as const;

describe('operator API client contracts after S06 mutation removal', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('does not export removed operator-side mutation helpers', () => {
    for (const name of removedMutationExports) {
      expect(client).not.toHaveProperty(name);
    }
  });

  it('preserves read clients plus bounded bootstrap and analyst chat writes', () => {
    for (const name of preservedReadAndBoundedWriteExports) {
      expect(client).toHaveProperty(name);
      expect(typeof client[name]).toBe('function');
    }
  });

  it('uses shared operator contract aliases for approved public responses', () => {
    const cards = null as unknown as CardChildrenResponse;
    const runtime = null as unknown as RuntimeStateResponse;
    const mcp = null as unknown as McpToolsResponse;
    const chat = null as unknown as ChatResponse;

    const cardsContract: OperatorApiSuccess<'cards.children'> = cards;
    const runtimeContract: OperatorApiSuccess<'runtime.getState'> = runtime;
    const mcpContract: OperatorApiSuccess<'mcp.tools'> = mcp;
    const chatContract: OperatorApiSuccess<'chats.send'> = chat;

    expect(cardsContract).toBeNull();
    expect(runtimeContract).toBeNull();
    expect(mcpContract).toBeNull();
    expect(chatContract).toBeNull();
  });

  it('shares the exact strict Analyst busy response contract', () => {
    const busy = {
      error: 'analyst_turn_busy',
      message: 'Another Analyst turn is active. Retry after it finishes.',
    };
    expect(AnalystTurnBusyErrorSchema.parse(busy)).toEqual(busy);
    expect(AnalystTurnBusyErrorSchema.safeParse({ ...busy, retryAfter: 1 }).success).toBe(false);
    expect(AnalystTurnBusyErrorSchema.safeParse({ ...busy, message: 'busy' }).success).toBe(false);
  });

  it('accepts only the displayed MCP server/tool hierarchy', () => {
    const stat = { total: 11, success: 9, error: 2, lastInvokedAt: '2026-07-22T12:34:56.000Z' };
    expect(() => parseOperatorResponse('mcp.tools', 200, {
      servers: [{ name: 'ghu_server', transport: 'stdio', status: 'running', toolCount: 1, tools: [{ name: 'tok_tool', description: 'nested-opaque-marker', inputSchema: { type: 'object' }, stats: stat }] }],
    })).toThrow();
    const parsed = parseOperatorResponse('mcp.tools', 200, {
      servers: [{ name: 'ghu_server', transport: 'stdio', status: 'running', toolCount: 1, tools: [{ name: 'tok_tool', stats: stat }] }],
    });
    expect(parsed).toEqual({
      servers: [{ name: 'ghu_server', transport: 'stdio', status: 'running', toolCount: 1, tools: [{ name: 'tok_tool', stats: stat }] }],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/opaque|description|inputSchema|annotations|_meta/);
  });

  it('returns exact shared Debug operation promises and rejects malformed Debug JSON', async () => {
    const errorsClient: () => Promise<OperatorApiSuccess<'debug.errors'>> = client.getDebugErrors;
    const timelineClient: () => Promise<OperatorApiSuccess<'events.list'>> = client.getNewestEvents;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ source: 'legacy' }], total: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(errorsClient()).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ events: [{ id: 'event-1', kind: 'obsolete_event', timestamp: '2026-01-01T00:00:00.000Z' }], total: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(timelineClient()).rejects.toThrow();
  });

  it('turns a validated declared failure into the operation/status-typed error', async () => {
    const data = {
      error: 'analyst_turn_busy' as const,
      message: 'Another Analyst turn is active. Retry after it finishes.' as const,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })));

    const failure = await client.sendChatMessage('question').catch((error: unknown) => error);

    expect(client.isOperatorApiError(failure, 'chats.send', 409)).toBe(true);
    expect(failure).toMatchObject({ operationId: 'chats.send', status: 409, data });
    expect((failure as Error).message).toBe(data.message);
  });

  it.each([
    ['malformed declared body', new Response(JSON.stringify({ error: 'analyst_turn_busy', message: 'Another Analyst turn is active. Retry after it finishes.', extra: true }), { status: 409 })],
    ['invalid JSON', new Response('{', { status: 409 })],
  ])('rejects %s before creating an OperatorApiError', async (_case, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const failure = await client.sendChatMessage('question').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(client.OperatorApiError);
  });

  it('rejects an undeclared 204 by status before decoding or returning data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const failure = await client.getRuntimeState().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(client.OperatorApiError);
    expect((failure as Error).message).toContain('does not declare response status 204');
  });

  it('dispatches auth-required only for a validated declared 401', async () => {
    window.sessionStorage.clear();
    const listener = vi.fn();
    window.addEventListener(API_AUTH_REQUIRED_EVENT, listener);
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unauthorized', statusCode: 401 }), { status: 401 })));
      const validated = await client.getRuntimeState().catch((error: unknown) => error);
      expect(client.isOperatorApiError(validated, 'runtime.getState', 401)).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })));
      const malformed = await client.getRuntimeState().catch((error: unknown) => error);
      expect(malformed).not.toBeInstanceOf(client.OperatorApiError);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(API_AUTH_REQUIRED_EVENT, listener);
    }
  });

  it('does not narrow a valid same-status error from the wrong operation', () => {
    const detailFailure = new client.OperatorApiError('agents.detail', 404, {
      error: 'Agent session not found',
    });

    expect(client.isOperatorApiError(detailFailure, 'agents.llmExchange', 404)).toBe(false);
  });

  it('requests the explicit newest 1000-event tail from the singular event endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events: [], total: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await client.getNewestEvents();
    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.pathname).toBe('/api/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({ selection: 'newest_tail', limit: '1000' });
  });

  it('retains exact Agent identities', () => {
    const agentId: Parameters<typeof client.getAgentConversation>[0] = 'agent:planner:project';
    const llmId: Parameters<typeof client.getAgentLlmExchange>[0] = agentId;
    const exact: ConversationSessionId = llmId;
    expect(exact).toBe('agent:planner:project');
  });

  it('serializes the literal current diff key and forwards record cancellation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ card_id: 'card-a', from: 2, to: 7, diff: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: 'record:///brief.md', size: 1, contentType: 'text/markdown', content: 'x', redacted: false, sensitivity: 'normal' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await client.getCardDiff({ cardId: 'card-a', fromSeq: 2, to: 'current' });
    const controller = new AbortController();
    await client.getFileContent('record:///brief.md?card=card-a&v=latest', controller.signal);
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get('to')).toBe('current');
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get('from')).toBe('2');
    expect(fetchMock.mock.calls[1]![1].signal).toBe(controller.signal);
  });
});
