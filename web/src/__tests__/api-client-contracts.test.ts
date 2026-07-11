import { describe, expect, it } from 'vitest';
import * as client from '../api/client';
import type { OperatorApiSuccess } from '../api/contracts';
import type { CardListResponse, ChatResponse, McpToolsResponse, RuntimeStateResponse } from '../api/types';

const removedMutationExports = [
  'createCard',
  'updateCard',
  'deleteCard',
  'startProject',
  'pauseRuntime',
  'resumeRuntime',
  'freezeRuntime',
  'resumeRuntimeFromFreeze',
  'acknowledgeNote',
  'deleteNote',
  'clearAllNotes',
  'acknowledgeNotification',
  'terminateProcess',
] as const;

const preservedReadAndBoundedWriteExports = [
  'listCards',
  'getCard',
  'getRuntimeState',
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
});
