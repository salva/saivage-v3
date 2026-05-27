import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAgentStore } from '../../stores/agents';

vi.mock('../../api/client', () => ({
  listAgentSessions: vi.fn(),
  getAgentConversation: vi.fn(),
  getAgentLlmExchange: vi.fn(),
  ApiError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));
vi.mock('../../stores/ws', () => ({ useWsStore: () => ({ onType: vi.fn(() => vi.fn()), onReconnect: vi.fn(() => vi.fn()) }) }));
import { getAgentConversation } from '../../api/client';

const session = { id: 's1', role: 'planner' as const, status: 'active' as const, started_at: '2026-01-01T00:00:00.000Z' };
const entry = { id: 'm1', session_id: 's1', role: 'assistant' as const, kind: 'text' as const, content: 'hello', round_id: 'r-assistant-1', message_index: 0, block_index: 0, timestamp: '2026-01-01T00:00:01.000Z' };
const activity_status = { status: 'idle' as const, pending_calls: [], updated_at: '2026-01-01T00:00:02.000Z' };

describe('useAgentStore conversation entries', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });
  it('loads entries and activity status from the conversation response', async () => {
    vi.mocked(getAgentConversation).mockResolvedValue({ session, entries: [entry], activity_status });
    const store = useAgentStore();
    await store.fetchConversation('s1');
    expect(store.entries).toEqual([entry]);
    expect(store.activityStatus).toEqual(activity_status);
  });
  it('appends matching websocket entries without exposing flat messages/steps', () => {
    const store = useAgentStore();
    store.currentSession = session;
    store.appendEntry(entry);
    expect(store.entries.map((item: typeof entry) => item.id)).toEqual(['m1']);
    expect('messages' in store).toBe(false);
    expect('steps' in store).toBe(false);
  });
});
