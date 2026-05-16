import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAnalystChat } from '../stores/analystChat';

vi.mock('../api/client', () => ({
  listChatSessions: vi.fn(async () => ({ sessions: [] })),
  getChatMessages: vi.fn(async (sessionId: string) => ({ sessionId, messages: [] })),
  sendChatMessage: vi.fn(async (sessionId: string) => ({ sessionId, message: { id: 'm1', content: 'reply', timestamp: '2025-01-01T00:00:00Z' } })),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));

describe('analyst chat store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    setActivePinia(createPinia());
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
});
