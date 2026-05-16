import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAnalystChat } from '../stores/analystChat';
import type { ChatMessage } from '../api/types';

const apiMocks = vi.hoisted(() => ({
  listChatSessions: vi.fn(),
  getChatMessages: vi.fn(),
  sendChatMessage: vi.fn(),
}));

vi.mock('../api/client', () => ({
  listChatSessions: apiMocks.listChatSessions,
  getChatMessages: apiMocks.getChatMessages,
  sendChatMessage: apiMocks.sendChatMessage,
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));

describe('analyst chat store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    setActivePinia(createPinia());
    apiMocks.listChatSessions.mockReset();
    apiMocks.getChatMessages.mockReset();
    apiMocks.sendChatMessage.mockReset();
    apiMocks.listChatSessions.mockResolvedValue({ sessions: [] });
    apiMocks.getChatMessages.mockResolvedValue({ sessionId: 'chat-1', messages: [] as ChatMessage[] });
    apiMocks.sendChatMessage.mockResolvedValue({ sessionId: 'chat-1', message: { id: 'm1', content: 'reply', timestamp: '2025-01-01T00:00:00Z' } });
  });

  it('seedCardContext produces stable session id shape', () => {
    const store = useAnalystChat();
    const sessionId = store.seedCardContext({ id: 'card-7', title: 'Investigate', status: 'active', version_seq: 4 } as any);
    expect(sessionId).toBe('card-card-7-1735689600000');
    expect(store.syntheticHint.sessionId).toBe(sessionId);
    expect(store.syntheticHint.content).toContain('card card-7');
    expect(store.unsavedSessionIds.has(sessionId)).toBe(true);
  });

  it('synthetic hint queue drains exactly once', async () => {
    const store = useAnalystChat();
    const sessionId = store.seedCardContext({ id: 'card-9', title: 'Seed', status: 'running', version_seq: 3 } as any);
    store.setDraft('what next?');
    const first = store.consumeSyntheticHint(sessionId);
    const second = store.consumeSyntheticHint(sessionId);
    expect(first).toContain('Treat the card as the default subject');
    expect(second).toBeNull();
  });

  it('keeps new chats local until first send', async () => {
    const store = useAnalystChat();
    const sessionId = store.createNewChat();
    await store.selectSession(sessionId);
    expect(store.activeSessionId).toBe(sessionId);
    expect(store.messages).toEqual([]);
    expect(store.messagesError).toBeNull();
  });

  it('keeps pending analyst tool chips visible until fetched tool messages exist', async () => {
    const store = useAnalystChat();
    await store.selectSession('chat-1');
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read_file', summary: 'opened docs', success: true });

    apiMocks.getChatMessages.mockResolvedValueOnce({
      sessionId: 'chat-1',
      messages: [
        { id: 'assistant-1', session_id: 'chat-1', role: 'assistant', kind: 'text', content: 'still thinking', timestamp: '2025-01-01T00:00:01Z' },
      ] satisfies ChatMessage[],
    });
    await store.fetchMessages('chat-1');
    expect(store.pendingToolInvocations).toHaveLength(1);

    apiMocks.getChatMessages.mockResolvedValueOnce({
      sessionId: 'chat-1',
      messages: [
        { id: 'tool-1', session_id: 'chat-1', role: 'tool', kind: 'tool_call', tool: 'read_file', content: JSON.stringify({ toolCalls: [{ tool: 'read_file', params: { path: 'docs/analyst.md' } }] }), timestamp: '2025-01-01T00:00:02Z' },
      ] satisfies ChatMessage[],
    });
    await store.fetchMessages('chat-1');
    expect(store.pendingToolInvocations).toEqual([]);
  });

  it('does not let unrelated session refetches clear the active session pending chips', async () => {
    const store = useAnalystChat();
    await store.selectSession('chat-1');
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read_file', summary: 'opened docs', success: true });

    apiMocks.getChatMessages.mockResolvedValueOnce({
      sessionId: 'chat-2',
      messages: [
        { id: 'tool-2', session_id: 'chat-2', role: 'tool', kind: 'tool_call', tool: 'read_file', content: JSON.stringify({ toolCalls: [{ tool: 'read_file', params: { path: 'README.md' } }] }), timestamp: '2025-01-01T00:00:02Z' },
      ] satisfies ChatMessage[],
    });
    await store.fetchMessages('chat-2');

    expect(store.pendingToolInvocations).toHaveLength(1);
    expect(store.pendingToolInvocations[0].sessionId).toBe('chat-1');
  });

  it('bounds pending attribution state and keeps the newest invocations', () => {
    const store = useAnalystChat();

    for (let index = 0; index < 15; index += 1) {
      store.ingestWsEvent({
        event: 'analyst_tool_invoked',
        sessionId: 'chat-1',
        tool: `tool-${index}`,
        summary: `summary-${index}`,
        success: true,
      });
    }

    expect(store.pendingToolInvocations).toHaveLength(12);
    expect(store.pendingToolInvocations[0].tool).toBe('tool-3');
    expect(store.pendingToolInvocations[11].tool).toBe('tool-14');
  });

  it('deduplicates repeated websocket analyst tool events for the same session and summary', () => {
    const store = useAnalystChat();

    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read_file', summary: 'opened docs', success: true });
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read_file', summary: 'opened docs', success: true });

    expect(store.pendingToolInvocations).toHaveLength(1);
  });
});
