import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { getAgentConversation, listAgentSessions } from '../api/client';
import type { AgentConversationResponse, AgentSession } from '../api/types';
import { useDebugStore } from '../stores/debug';

vi.mock('../api/client', () => ({
  getDebugState: vi.fn().mockResolvedValue({ runtime: null, cards: [], totalCards: 0 }),
  getDebugErrors: vi.fn().mockResolvedValue({ errors: [], total: 0 }),
  getDebugTimeline: vi.fn().mockResolvedValue({ events: [], total: 0 }),
  getDoctor: vi.fn().mockResolvedValue({ status: 'ok', checks: [], issues: [] }),
  getDebugSupervision: vi.fn().mockResolvedValue({ reviews: [], quarantine: [], stats: null }),
  listProcesses: vi.fn().mockResolvedValue({ processes: [] }),
  listAgentSessions: vi.fn(),
  listFiles: vi.fn().mockResolvedValue({ files: [] }),
  getAgentConversation: vi.fn(),
  getAgentLlmExchange: vi.fn().mockResolvedValue({ entries: [] }),
  getFileContent: vi.fn().mockResolvedValue({ content: '' }),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

function makeSession(id: string): AgentSession {
  return {
    id,
    role: 'planner',
    status: 'active',
    goal_card_id: 'goal-1',
    card_id: 'card-1',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    model: 'test-model',
  };
}

function makeConversation(session: AgentSession, entryId: string): AgentConversationResponse {
  return {
    session,
    entries: [{
      id: entryId,
      session_id: session.id,
      role: 'assistant',
      kind: 'text',
      content: entryId,
      round_id: `round-${entryId}`,
      message_index: 0,
      block_index: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
    }],
    activity_status: { status: 'idle', pending_calls: [], updated_at: '2026-01-01T00:00:00.000Z' },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function makeStoreWithSessions(sessions: AgentSession[], conversation: AgentConversationResponse) {
  setActivePinia(createPinia());
  vi.mocked(listAgentSessions).mockResolvedValue({ sessions });
  vi.mocked(getAgentConversation).mockResolvedValue(conversation);
  const store = useDebugStore();
  await store.refreshAgentDebug();
  vi.mocked(getAgentConversation).mockClear();
  return store;
}

describe('debug store selected agent conversation refetch', () => {
  const sessionA = makeSession('session-a');
  const sessionB = makeSession('session-b');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when the selected debug kind is not conversation', async () => {
    const existing = makeConversation(sessionA, 'existing');
    const store = await makeStoreWithSessions([sessionA], existing);

    store.selectedAgentDebugKind = 'llmExchange';
    await store.refetchSelectedAgentDebugConversation();

    expect(getAgentConversation).not.toHaveBeenCalled();
    expect(store.selectedAgentDebugConversation).toEqual(existing);
  });

  it('does nothing when no agent debug session is selected', async () => {
    setActivePinia(createPinia());
    const store = useDebugStore();

    await store.refetchSelectedAgentDebugConversation();

    expect(getAgentConversation).not.toHaveBeenCalled();
    expect(store.selectedAgentDebugConversation).toBeNull();
  });

  it('updates the selected conversation in place without toggling visible loading state', async () => {
    const existing = makeConversation(sessionA, 'existing');
    const next = makeConversation(sessionA, 'next');
    const store = await makeStoreWithSessions([sessionA], existing);
    const pending = deferred<AgentConversationResponse>();
    vi.mocked(getAgentConversation).mockReturnValueOnce(pending.promise);

    const refetch = store.refetchSelectedAgentDebugConversation();

    expect(getAgentConversation).toHaveBeenCalledWith(sessionA.id);
    expect(store.selectedAgentDebugConversation).toEqual(existing);
    expect(store.agentDebugContentLoading).toBe(false);
    pending.resolve(next);
    await refetch;

    expect(store.selectedAgentDebugConversation).toEqual(next);
    expect(store.agentDebugContentLoading).toBe(false);
  });

  it('discards an in-flight response after the selected session changes', async () => {
    const existing = makeConversation(sessionA, 'existing');
    const stale = makeConversation(sessionA, 'stale');
    const store = await makeStoreWithSessions([sessionA, sessionB], existing);
    const pendingA = deferred<AgentConversationResponse>();
    const pendingB = deferred<AgentConversationResponse>();
    vi.mocked(getAgentConversation)
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);

    const refetch = store.refetchSelectedAgentDebugConversation();
    store.selectAgentDebugSession(sessionB.id);
    pendingA.resolve(stale);
    await refetch;

    expect(store.selectedAgentDebugSessionId).toBe(sessionB.id);
    expect(store.selectedAgentDebugConversation).not.toBe(stale);
    pendingB.resolve(makeConversation(sessionB, 'session-b'));
  });

  it('keeps visible content and error state unchanged when background refetch fails', async () => {
    const existing = makeConversation(sessionA, 'existing');
    const store = await makeStoreWithSessions([sessionA], existing);
    vi.mocked(getAgentConversation).mockRejectedValueOnce(new Error('network failed'));

    await store.refetchSelectedAgentDebugConversation();

    expect(store.selectedAgentDebugConversation).toEqual(existing);
    expect(store.agentDebugContentError).toBeNull();
  });
});
