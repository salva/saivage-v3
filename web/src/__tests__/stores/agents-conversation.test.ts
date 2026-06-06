import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAgentStore } from '../../stores/agents';
import type { ActivityStatus, AgentConversationEntry, AgentSession } from '../../api/types';

vi.mock('../../api/client', () => ({
  listAgentSessions: vi.fn(),
  getAgentConversation: vi.fn(),
  getAgentLlmExchange: vi.fn(),
  ApiError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));
import { getAgentConversation, listAgentSessions } from '../../api/client';

const session: AgentSession = { id: 's1', role: 'planner', status: 'active', started_at: '2026-01-01T00:00:00.000Z' };
const entry: AgentConversationEntry = { id: 'm1', session_id: 's1', role: 'assistant', kind: 'text', content: 'hello', round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: '2026-01-01T00:00:01.000Z' };
const activity_status: ActivityStatus = { status: 'idle', pending_calls: [], updated_at: '2026-01-01T00:00:02.000Z' };

describe('useAgentStore conversation entries', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });
  it('loads sessions from the contract-backed agent list response', async () => {
    vi.mocked(listAgentSessions).mockResolvedValue({ sessions: [session] });
    const store = useAgentStore();
    await store.fetchSessions();
    expect(store.sessions).toEqual([session]);
    expect(store.lastUpdatedBy).toBe('rest');
  });
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
    expect(store.entries.map((item) => item.id)).toEqual(['m1']);
    expect('messages' in store).toBe(false);
    expect('steps' in store).toBe(false);
  });
});
