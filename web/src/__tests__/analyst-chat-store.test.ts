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
    apiMocks.listChatSessions.mockResolvedValue({ sessions: [{ id: 'analyst', role: 'analyst', status: 'active', started_at: '2025-01-01T00:00:00Z' }] });
    apiMocks.getChatMessages.mockResolvedValue({ sessionId: 'analyst', messages: [] as ChatMessage[] });
    apiMocks.sendChatMessage.mockResolvedValue({ sessionId: 'analyst', message: { id: 'm1', content: 'reply', timestamp: '2025-01-01T00:00:00Z' } });
  });

  it('seedCardContext reuses the canonical analyst session and seeds get_card context', () => {
    const store = useAnalystChat();
    const card = { id: 'card-7', title: 'Investigate', description: 'Find the regression', status: 'active', version_seq: 4, blocks: ['child-1'], depends_on: ['dep-1'] } as any;
    const first = store.seedCardContext(card);
    const firstHint = store.syntheticHint.content;
    const second = store.seedCardContext(card);
    expect(first).toBe('analyst');
    expect(second).toBe('analyst');
    expect(store.syntheticHint.content).toBe(firstHint);
    expect(firstHint).toContain('Card title: Investigate');
    expect(firstHint).toContain('Card description: Find the regression');
    expect(firstHint).toContain('Card status: active');
    expect(firstHint).toContain('blocks:child-1');
    expect(firstHint).toContain('Tool result get_card:');
    expect(firstHint).toContain('\"tool\":\"get_card\"');
  });

  it('synthetic hint queue drains exactly once', async () => {
    const store = useAnalystChat();
    const sessionId = store.seedCardContext({ id: 'card-9', title: 'Seed', status: 'running', version_seq: 3 } as any);
    store.setDraft('what next?');
    const first = store.consumeSyntheticHint(sessionId);
    const second = store.consumeSyntheticHint(sessionId);
    expect(first).toContain('Use this seeded card context as the default subject');
    expect(second).toBeNull();
  });

  it('createNewChat resolves to the canonical analyst session', async () => {
    const store = useAnalystChat();
    const sessionId = store.createNewChat();
    expect(sessionId).toBe('analyst');
    expect(store.activeSessionId).toBe('analyst');
    expect(store.messagesError).toBeNull();
  });

  it('keeps pending analyst tool chips visible until fetched tool messages exist', async () => {
    const store = useAnalystChat();
    await store.selectSession('analyst');
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'stale-chat-id', tool: 'read_file', summary: 'opened docs', success: true });

    apiMocks.getChatMessages.mockResolvedValueOnce({
      sessionId: 'analyst',
      messages: [
        { id: 'assistant-1', session_id: 'analyst', role: 'assistant', kind: 'text', content: 'still thinking', round_id: 'r-assistant-1', message_index: 0, block_index: 0, timestamp: '2025-01-01T00:00:01Z' },
      ] satisfies ChatMessage[],
    });
    await store.fetchMessages('analyst');
    expect(store.pendingToolInvocations).toHaveLength(1);

    apiMocks.getChatMessages.mockResolvedValueOnce({
      sessionId: 'analyst',
      messages: [
        { id: 'tool-1', session_id: 'analyst', role: 'tool', kind: 'tool_call', tool: 'read_file', content: JSON.stringify({ toolCalls: [{ tool: 'read_file', params: { path: 'docs/analyst.md' } }] }), round_id: 'r-assistant-1', message_index: 1, block_index: 0, timestamp: '2025-01-01T00:00:02Z' },
      ] satisfies ChatMessage[],
    });
    await store.fetchMessages('analyst');
    expect(store.pendingToolInvocations).toEqual([]);
  });

  it('canonicalizes requested fetch session ids to the single analyst chat', async () => {
    const store = useAnalystChat();

    apiMocks.getChatMessages.mockResolvedValueOnce({
      sessionId: 'analyst',
      messages: [] satisfies ChatMessage[],
    });
    await store.fetchMessages('chat-2');

    expect(apiMocks.getChatMessages).toHaveBeenLastCalledWith('analyst');
    expect(store.activeSessionId).toBe('analyst');
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

  it('normalizes snake_case session ids, bounded summaries, and empty tool names from sanitized payloads', () => {
    const store = useAnalystChat();

    store.ingestWsEvent({
      event: 'analyst_tool_invoked',
      session_id: 'chat-1',
      tool: '   ',
      summary: `  ${'x'.repeat(250)}   `,
      classified_as: 'read_only',
      related_card_id: 'card-9',
      success: true,
    });

    expect(store.pendingToolInvocations).toHaveLength(1);
    expect(store.pendingToolInvocations[0]).toMatchObject({
      sessionId: 'analyst',
      tool: 'tool',
      classifiedAs: 'read_only',
      relatedCardId: 'card-9',
      success: true,
    });
    expect(store.pendingToolInvocations[0].summary).toHaveLength(200);
  });

  it('falls back to a safe default summary when the payload summary is empty or missing', () => {
    const store = useAnalystChat();

    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read_file', summary: '   ', success: true });
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-2', tool: 'list_directory', success: true });

    expect(store.pendingToolInvocations[0].summary).toBe('tool invoked');
    expect(store.pendingToolInvocations[1].summary).toBe('tool invoked');
  });

  it('collapses stale analyst session ids when deduping otherwise identical events', () => {
    const store = useAnalystChat();

    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read_file', summary: 'opened docs', success: true });
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-2', tool: 'read_file', summary: 'opened docs', success: true });

    expect(store.pendingToolInvocations).toHaveLength(1);
    expect(store.pendingToolInvocations[0].sessionId).toBe('analyst');
  });
});
