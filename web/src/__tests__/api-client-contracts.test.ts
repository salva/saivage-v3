import { describe, expect, it } from 'vitest';
import * as client from '../api/client';
import type { ConversationSessionId, OperatorApiSuccess } from '../api/contracts';
import type { CardListResponse, ChatResponse, McpToolsResponse, RuntimeStateResponse } from '../api/types';

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
  'listCards',
  'getCard',
  'getRuntimeState',
  'getRuntimeStatus',
  'stopProject',
  'restartServer',
  'issueWebSocketTicket',
  'sendChatMessage',
] as const;

describe('operator API client contracts after S06 mutation removal', () => {
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
    const cards = null as unknown as CardListResponse;
    const runtime = null as unknown as RuntimeStateResponse;
    const mcp = null as unknown as McpToolsResponse;
    const chat = null as unknown as ChatResponse;

    const cardsContract: OperatorApiSuccess<'cards.list'> = cards;
    const runtimeContract: OperatorApiSuccess<'runtime.getState'> = runtime;
    const mcpContract: OperatorApiSuccess<'mcp.tools'> = mcp;
    const chatContract: OperatorApiSuccess<'chats.send'> = chat;

    expect(cardsContract).toBeNull();
    expect(runtimeContract).toBeNull();
    expect(mcpContract).toBeNull();
    expect(chatContract).toBeNull();
  });

  it('retains exact Agent identities and identity-free Analyst method signatures', () => {
    const agentId: Parameters<typeof client.getAgentConversation>[0] = 'planner:project';
    const llmId: Parameters<typeof client.getAgentLlmExchange>[0] = agentId;
    const exact: ConversationSessionId = llmId;
    const chatSignal: Parameters<typeof client.getChatEntries>[0] = undefined;
    const chatContent: Parameters<typeof client.sendChatMessage>[0] = 'hello';
    expect({ exact, chatSignal, chatContent }).toEqual({ exact: 'planner:project', chatSignal: undefined, chatContent: 'hello' });
  });
});
