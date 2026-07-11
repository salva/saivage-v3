import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAgentStore } from '../../stores/agents';
import type { ActivityStatus, AgentSession } from '../../api/types';

vi.mock('../../api/client', () => ({
  listAgentSessions: vi.fn(),
  getAgentConversation: vi.fn(),
  getAgentLlmExchange: vi.fn(),
  ApiError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));
import { getAgentConversation, listAgentSessions, getAgentLlmExchange } from '../../api/client';

const session: AgentSession = { id: 's1', role: 'planner', status: 'active', started_at: '2026-01-01T00:00:00.000Z' };
const entry = { id: 'm1', session_id: 's1', role: 'assistant', kind: 'text', content: 'hello', round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: '2026-01-01T00:00:01.000Z' } as const;
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
  it('does not expose flat messages/steps', () => {
    const store = useAgentStore();
    expect('messages' in store).toBe(false);
    expect('steps' in store).toBe(false);
  });
  it('keeps the newest deferred conversation selection when an older request resolves late', async () => {
    let resolveFirst!: (value: any) => void;
    let resolveSecond!: (value: any) => void;
    vi.mocked(getAgentConversation)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const store = useAgentStore();
    const first = store.fetchConversation('s1');
    const second = store.fetchConversation('s2');
    resolveSecond({ session: { ...session, id: 's2' }, entries: [{ ...entry, session_id: 's2', content: 'new' }], activity_status });
    await second;
    resolveFirst({ session, entries: [entry], activity_status });
    await first;
    expect(store.currentSession?.id).toBe('s2');
    expect(store.entries[0]?.content).toBe('new');
  });
  it('does not let a deferred older exchange clear the current exchange loading state', async () => {
    let resolveFirst!: (value: any) => void;
    let resolveSecond!: (value: any) => void;
    vi.mocked(getAgentLlmExchange)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const store = useAgentStore();
    const first = store.fetchLlmExchange('s1');
    const second = store.fetchLlmExchange('s2');
    resolveSecond({ exchange: { provider: 'new' } });
    await second;
    resolveFirst({ exchange: { provider: 'old' } });
    await first;
    expect(store.llmExchangeSessionId).toBe('s2');
    expect(store.currentLlmExchange).toEqual({ provider: 'new' });
    expect(store.llmExchangeLoading).toBe(false);
  });
});
