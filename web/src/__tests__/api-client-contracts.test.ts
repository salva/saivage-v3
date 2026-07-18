import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '../api/client';
import type { ConversationSessionId, OperatorApiSuccess } from '../api/contracts';
import type { CardChildrenResponse, ChatResponse, McpToolsResponse, RuntimeStateResponse } from '../api/types';

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

  it('retains exact Agent identities', () => {
    const agentId: Parameters<typeof client.getAgentConversation>[0] = 'planner:project';
    const llmId: Parameters<typeof client.getAgentLlmExchange>[0] = agentId;
    const exact: ConversationSessionId = llmId;
    expect(exact).toBe('planner:project');
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
