import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAnalystChat } from '../stores/analystChat';
import type { AgentConversationEntry } from '../api/types';

const apiMocks = vi.hoisted(() => ({
  listChatSessions: vi.fn(),
  getChatEntries: vi.fn(),
  sendChatMessage: vi.fn(),
}));

vi.mock('../api/client', () => ({
  listChatSessions: apiMocks.listChatSessions,
  getChatEntries: apiMocks.getChatEntries,
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
    apiMocks.getChatEntries.mockReset();
    apiMocks.sendChatMessage.mockReset();
    apiMocks.listChatSessions.mockResolvedValue({ sessions: [{ id: 'analyst:global', role: 'analyst', status: 'active', started_at: '2025-01-01T00:00:00Z' }] });
    apiMocks.getChatEntries.mockResolvedValue({ sessionId: 'analyst:global', entries: [] as AgentConversationEntry[] });
    apiMocks.sendChatMessage.mockResolvedValue({ sessionId: 'analyst:global', message: { id: 'm1', role: 'assistant', kind: 'text', content: 'reply', timestamp: '2025-01-01T00:00:00Z' }, toolInvocations: [] });
  });

  it('seedCardContext reuses the canonical analyst session and seeds get_card context', () => {
    const store = useAnalystChat();
    const card = { id: 'card-7', title: 'Investigate', status: 'running', version_seq: 4, depends_on: ['dep-1'], lifecycle: { error: null } } as any;
    const first = store.seedCardContext(card);
    const firstHint = store.syntheticHint.content;
    const second = store.seedCardContext(card);
    expect(first).toBe('analyst:global');
    expect(second).toBe('analyst:global');
    expect(store.syntheticHint.content).toBe(firstHint);
    expect(firstHint).toContain('Card title: Investigate');
    expect(firstHint).toContain('Card status: running');
    expect(firstHint).toContain('depends_on:dep-1');
    expect(firstHint).toContain('Tool result get_card:');
    expect(firstHint).toContain('\"tool\":\"get_card\"');
  });

  it('synthetic hint queue drains exactly once', async () => {
    const store = useAnalystChat();
    const sessionId = store.seedCardContext({ id: 'card-9', title: 'Seed', status: 'running', version_seq: 3, lifecycle: { error: null } } as any);
    store.setDraft('what next?');
    const first = store.consumeSyntheticHint(sessionId);
    const second = store.consumeSyntheticHint(sessionId);
    expect(first).toContain('Use this seeded card context as the default subject');
    expect(second).toBeNull();
  });

  it('createNewChat resolves to the canonical analyst session', async () => {
    const store = useAnalystChat();
    const sessionId = store.createNewChat();
    expect(sessionId).toBe('analyst:global');
    expect(store.activeSessionId).toBe('analyst:global');
    expect(store.messagesError).toBeNull();
  });

  it('keeps pending analyst tool chips visible until fetched tool messages exist', async () => {
    const store = useAnalystChat();
    await store.selectSession('analyst:global');
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'stale-chat-id', tool: 'read', summary: 'opened docs', success: true });

    apiMocks.getChatEntries.mockResolvedValueOnce({
      sessionId: 'analyst:global',
      entries: [
        { id: 'assistant-1', session_id: 'analyst:global', role: 'assistant', kind: 'text', content: 'still thinking', round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: '2025-01-01T00:00:01Z' },
      ] satisfies AgentConversationEntry[],
    });
    await store.fetchMessages('analyst:global');
    expect(store.pendingToolInvocations).toHaveLength(1);

    apiMocks.getChatEntries.mockResolvedValueOnce({
      sessionId: 'analyst:global',
      entries: [
        { id: 'tool-1', session_id: 'analyst:global', role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: 'tool-1', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'docs/analyst.md' }) } }] }), round_id: 'r-assistant-00000000000000000000000000000001', message_index: 1, block_index: 0, timestamp: '2025-01-01T00:00:02Z' },
      ] satisfies AgentConversationEntry[],
    });
    await store.fetchMessages('analyst:global');
    expect(store.pendingToolInvocations).toEqual([]);
  });

  it('resolves pending tool chip via persisted single-row tool_call (assistant) + tool_result (tool) pair (E09 regression)', async () => {
    const store = useAnalystChat();
    await store.selectSession('analyst:global');
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'analyst:global', tool: 'list_cards', summary: 'listed cards', success: true });
    expect(store.pendingToolInvocations).toHaveLength(1);

    apiMocks.getChatEntries.mockResolvedValueOnce({
      sessionId: 'analyst:global',
      entries: [
        { id: 'tc-1', session_id: 'analyst:global', role: 'assistant', kind: 'tool_call', tool: 'list_cards', tool_call_id: 'call-77', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-77', type: 'function', function: { name: 'list_cards', arguments: '{}' } }] }), round_id: 'r-assistant-00000000000000000000000000000002', message_index: 0, block_index: 0, timestamp: '2025-01-01T00:00:03Z' },
        { id: 'tr-1', session_id: 'analyst:global', role: 'tool', kind: 'tool_result', tool: 'list_cards', tool_call_id: 'call-77', content: '{}', round_id: 'r-assistant-00000000000000000000000000000002', message_index: 0, block_index: 1, timestamp: '2025-01-01T00:00:04Z' },
      ] satisfies AgentConversationEntry[],
    });
    await store.fetchMessages('analyst:global');
    expect(store.pendingToolInvocations).toEqual([]);
  });

  it('canonicalizes requested fetch session ids to the single analyst chat', async () => {
    const store = useAnalystChat();

    apiMocks.getChatEntries.mockResolvedValueOnce({
      sessionId: 'analyst:global',
      entries: [] satisfies AgentConversationEntry[],
    });
    await store.fetchMessages('chat-2');

    expect(apiMocks.getChatEntries).toHaveBeenLastCalledWith('analyst:global');
    expect(store.activeSessionId).toBe('analyst:global');
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

    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read', summary: 'opened docs', success: true });
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read', summary: 'opened docs', success: true });

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
      sessionId: 'analyst:global',
      tool: 'tool',
      classifiedAs: 'read_only',
      relatedCardId: 'card-9',
      success: true,
    });
    expect(store.pendingToolInvocations[0].summary).toHaveLength(200);
  });

  it('falls back to a safe default summary when the payload summary is empty or missing', () => {
    const store = useAnalystChat();

    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read', summary: '   ', success: true });
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-2', tool: 'glob', success: true });

    expect(store.pendingToolInvocations[0].summary).toBe('tool invoked');
    expect(store.pendingToolInvocations[1].summary).toBe('tool invoked');
  });

  it('collapses stale analyst session ids when deduping otherwise identical events', () => {
    const store = useAnalystChat();

    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read', summary: 'opened docs', success: true });
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-2', tool: 'read', summary: 'opened docs', success: true });

    expect(store.pendingToolInvocations).toHaveLength(1);
    expect(store.pendingToolInvocations[0].sessionId).toBe('analyst:global');
  });
});
