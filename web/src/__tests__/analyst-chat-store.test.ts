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
    apiMocks.sendChatMessage.mockResolvedValue({ sessionId: 'analyst:global', toolInvocations: [] });
  });

  it('createNewChat resolves to the canonical analyst session', async () => {
    const store = useAnalystChat();
    const sessionId = store.createNewChat();
    expect(sessionId).toBe('analyst:global');
    expect(store.activeSessionId).toBe('analyst:global');
    expect(store.messagesError).toBeNull();
  });

  it('does not refresh transcript from analyst tool activity frames', async () => {
    const store = useAnalystChat();
    await store.selectSession('analyst:global');
    apiMocks.getChatEntries.mockClear();

    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'analyst:global', tool: 'list_cards', summary: 'listed cards', success: true });

    expect(apiMocks.getChatEntries).not.toHaveBeenCalled();
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

  it('does not refresh transcript from card or control activity frames', async () => {
    const store = useAnalystChat();
    await store.selectSession('analyst:global');
    apiMocks.getChatEntries.mockClear();

    store.ingestWsEvent({ event: 'card_history_appended', sessionId: 'analyst:global' });
    store.ingestWsEvent({ event: 'control_action_recorded', sessionId: 'analyst:global', actor: 'analyst', surface: 'web-chat', action: 'approved', target_id: 'card-1' });

    expect(apiMocks.getChatEntries).not.toHaveBeenCalled();
  });
});
