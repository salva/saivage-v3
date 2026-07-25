import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { AgentConversationEntry, AgentSession } from '../../api/types';
import { useAgentStore } from '../../stores/agents';

vi.mock('../../api/client', () => ({
  listAgentSessions: vi.fn(),
  getAgentSession: vi.fn(),
  getCardAgentSessions: vi.fn(),
  getAgentConversation: vi.fn(),
  getAgentLlmExchange: vi.fn(),
  ApiError: class extends Error {
    constructor(
      public status: number,
      message: string,
      public body: Record<string, unknown>,
    ) {
      super(message);
    }
    get isUnauthorized() {
      return this.status === 401;
    }
    get isNotFound() {
      return this.status === 404;
    }
  },
}));

import {
  ApiError,
  getAgentConversation,
  getAgentLlmExchange,
  getAgentSession,
  getCardAgentSessions,
  listAgentSessions,
} from '../../api/client';

const S1 = 'agent:planner:project' as const;
const S2 = 'agent:reviewer:project' as const;
const session: AgentSession = {
  id: S1,
  agent_name: 'planner',
  session_scope: 'card',
  card_id: 'project',
  started_at: '2026-01-01T00:00:00.000Z',
};
const reviewerSession: AgentSession = {
  ...session,
  id: S2,
  agent_name: 'reviewer',
};
const entry = {
  id: 'm1',
  session_id: S1,
  role: 'assistant',
  kind: 'text',
  content: 'hello',
  round_id: 'r-assistant-00000000000000000000000000000001',
  message_index: 0,
  block_index: 0,
  timestamp: '2026-01-01T00:00:01.000Z',
} as const;
const exchange = { provider: 'provider-one' } as any;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function conversation(entries: AgentConversationEntry[] = [entry], cursor = 'm1') {
  return { session_id: S1, entries, cursor };
}

describe('useAgentStore singular agent resource ownership', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(getAgentSession).mockResolvedValue({ session });
  });

  it('treats an accepted empty baseline as loaded and preserves it on refresh failure', async () => {
    vi.mocked(listAgentSessions)
      .mockResolvedValueOnce({ sessions: [] })
      .mockRejectedValueOnce(new ApiError(500, 'refresh failed', {}));
    const store = useAgentStore();
    await store.fetchSessions();
    const refresh = store.fetchSessions();
    expect(store.sessionsRefreshing).toBe(true);
    await expect(refresh).rejects.toThrow('refresh failed');
    expect(store.sessions).toEqual([]);
    expect(store.sessionsLoaded).toBe(true);
    expect(store.sessionsError).toBeNull();
    expect(store.sessionsRefreshError).toBe('refresh failed');
  });

  it('keeps inventory, conversation, and exchange request state independent', async () => {
    const list = deferred<{ sessions: AgentSession[] }>();
    const detail = deferred<{ session: AgentSession }>();
    const transcript = deferred<ReturnType<typeof conversation>>();
    const raw = deferred<any>();
    vi.mocked(listAgentSessions).mockReturnValue(list.promise);
    vi.mocked(getAgentSession).mockReturnValue(detail.promise);
    vi.mocked(getAgentConversation).mockReturnValue(transcript.promise);
    vi.mocked(getAgentLlmExchange).mockReturnValue(raw.promise);
    const store = useAgentStore();
    const conversationToken = store.beginConversationSelection(S1);
    const exchangeToken = store.beginLlmExchangeSelection(S1);
    const requests = [
      store.fetchSessions(),
      store.fetchConversation(conversationToken),
      store.fetchLlmExchange(exchangeToken),
    ];
    expect(store.sessionsLoading).toBe(true);
    expect(store.conversationLoading).toBe(true);
    expect(store.llmExchangeLoading).toBe(true);
    list.resolve({ sessions: [session] });
    detail.resolve({ session });
    transcript.resolve(conversation());
    raw.resolve({ sessionId: S1, exchange });
    await Promise.all(requests);
    expect(store.currentSession).toEqual(session);
    expect(store.entries).toEqual([entry]);
    expect(store.currentLlmExchange).toEqual(exchange);
  });

  it('aborts a superseded inventory request and ignores its late completion', async () => {
    const oldRequest = deferred<{ sessions: AgentSession[] }>();
    let oldSignal: AbortSignal | undefined;
    vi.mocked(listAgentSessions)
      .mockImplementationOnce((signal) => {
        oldSignal = signal;
        return oldRequest.promise;
      })
      .mockResolvedValueOnce({ sessions: [reviewerSession] });
    const store = useAgentStore();
    const oldFetch = store.fetchSessions();
    await store.fetchSessions();
    expect(oldSignal?.aborted).toBe(true);
    oldRequest.resolve({ sessions: [session] });
    await expect(oldFetch).resolves.toBe(false);
    expect(store.sessions.map(({ id }) => id)).toEqual([S2]);
  });

  it('release aborts inventory ownership and clears accepted partitions', async () => {
    const pending = deferred<{ sessions: AgentSession[] }>();
    let signal: AbortSignal | undefined;
    vi.mocked(listAgentSessions).mockImplementation((requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    });
    const store = useAgentStore();
    const request = store.fetchSessions();
    store.releaseSessions();
    expect(signal?.aborted).toBe(true);
    pending.resolve({ sessions: [session] });
    await expect(request).resolves.toBe(false);
    expect(store.sessionsLoaded).toBe(false);
    expect(store.sessions).toEqual([]);
  });

  it('replaces only the affected card partition and removes it on authoritative 404', async () => {
    vi.mocked(listAgentSessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(getCardAgentSessions)
      .mockResolvedValueOnce({ card_id: 'project', sessions: [reviewerSession] })
      .mockRejectedValueOnce(new ApiError(404, 'missing', { error: 'Card not found' }));
    const store = useAgentStore();
    await store.fetchSessions();
    const frame = {
      t: 'invalidate',
      resource: 'agent-membership',
      scope: 'card',
      card_id: 'project',
    } as const;
    await store.reconcileMembership(frame);
    expect(store.sessions).toEqual([reviewerSession]);
    await store.reconcileMembership(frame);
    expect(store.sessions).toEqual([]);
    expect(listAgentSessions).toHaveBeenCalledTimes(1);
  });

  it('retains accepted transcript data and records only a same-session refresh error', async () => {
    vi.mocked(getAgentConversation)
      .mockResolvedValueOnce(conversation())
      .mockRejectedValueOnce(new ApiError(500, 'conversation refresh failed', {}));
    const store = useAgentStore();
    const token = store.beginConversationSelection(S1);
    await store.fetchConversation(token);
    const refresh = store.refetchConversation(token);
    expect(store.conversationRefreshing).toBe(true);
    await expect(refresh).rejects.toThrow('conversation refresh failed');
    expect(store.entries).toEqual([entry]);
    expect(store.conversationError).toBeNull();
    expect(store.conversationRefreshError).toBe('conversation refresh failed');
  });

  it('appends cursor deltas without reordering or pair expansion', async () => {
    const result = { ...entry, id: 'm2', kind: 'tool_result' as const, role: 'tool' as const };
    vi.mocked(getAgentConversation)
      .mockResolvedValueOnce(conversation([entry], 'm1'))
      .mockResolvedValueOnce(conversation([result], 'm2'));
    const store = useAgentStore();
    const token = store.beginConversationSelection(S1);
    await store.fetchConversation(token);
    await store.fetchConversation(token);
    expect(getAgentConversation).toHaveBeenNthCalledWith(2, S1, expect.any(AbortSignal), 'm1');
    expect(store.entries.map(({ id }) => id)).toEqual(['m1', 'm2']);
  });

  it('makes stale transcript tokens, completions, refetches, and clears inert', async () => {
    const oldRequest = deferred<any>();
    vi.mocked(getAgentConversation)
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({
        session_id: S2,
        entries: [{ ...entry, session_id: S2 }],
        cursor: 'm2',
      });
    vi.mocked(getAgentSession)
      .mockResolvedValueOnce({ session })
      .mockResolvedValueOnce({ session: reviewerSession });
    const store = useAgentStore();
    const oldToken = store.beginConversationSelection(S1);
    const oldFetch = store.fetchConversation(oldToken);
    const newToken = store.beginConversationSelection(S2);
    await store.fetchConversation(newToken);
    await store.refetchConversation(oldToken);
    store.clearConversationSelection(oldToken);
    oldRequest.resolve(conversation());
    await oldFetch;
    expect(store.currentSession?.id).toBe(S2);
    expect(store.entries[0]?.session_id).toBe(S2);
  });

  it('clear aborts and generation-invalidates an in-flight transcript', async () => {
    const request = deferred<any>();
    let signal: AbortSignal | undefined;
    vi.mocked(getAgentConversation).mockImplementation((_id, requestSignal) => {
      signal = requestSignal;
      return request.promise;
    });
    const store = useAgentStore();
    const token = store.beginConversationSelection(S1);
    const fetch = store.fetchConversation(token);
    await Promise.resolve();
    store.clearConversationSelection(token);
    expect(signal?.aborted).toBe(true);
    request.resolve(conversation());
    await fetch;
    expect(store.selectedConversationSessionId).toBeNull();
    expect(store.currentSession).toBeNull();
  });

  it('accepts only the exact no-exchange 404 as loaded empty', async () => {
    vi.mocked(getAgentLlmExchange).mockRejectedValueOnce(
      new ApiError(404, 'missing', { error: 'No LLM exchange recorded for this session yet.' }),
    );
    const store = useAgentStore();
    const token = store.beginLlmExchangeSelection(S1);
    await store.fetchLlmExchange(token);
    expect(store.llmExchangeLoaded).toBe(true);
    expect(store.currentLlmExchange).toBeNull();
    expect(store.llmExchangeError).toBeNull();

    const wrong = store.beginLlmExchangeSelection(S1);
    vi.mocked(getAgentLlmExchange).mockRejectedValueOnce(
      new ApiError(404, 'wrong resource', { error: 'Agent session not found' }),
    );
    await store.fetchLlmExchange(wrong);
    expect(store.llmExchangeLoaded).toBe(false);
    expect(store.llmExchangeError).toBe('wrong resource');
  });

  it('retains accepted exchange state on a non-404 refresh failure', async () => {
    vi.mocked(getAgentLlmExchange)
      .mockResolvedValueOnce({ sessionId: S1, exchange })
      .mockRejectedValueOnce(new ApiError(500, 'refresh failed', {}));
    const store = useAgentStore();
    const token = store.beginLlmExchangeSelection(S1);
    await store.fetchLlmExchange(token);
    await store.fetchLlmExchange(token);
    expect(store.currentLlmExchange).toEqual(exchange);
    expect(store.llmExchangeRefreshError).toBe('refresh failed');
  });

  it('aborts and ignores late exchange completion and stale same-session cleanup', async () => {
    const oldRequest = deferred<any>();
    let oldSignal: AbortSignal | undefined;
    vi.mocked(getAgentLlmExchange)
      .mockImplementationOnce((_id, signal) => {
        oldSignal = signal;
        return oldRequest.promise;
      })
      .mockResolvedValueOnce({ sessionId: S1, exchange: { provider: 'new' } as any });
    const store = useAgentStore();
    const oldToken = store.beginLlmExchangeSelection(S1);
    const oldFetch = store.fetchLlmExchange(oldToken);
    await Promise.resolve();
    const newToken = store.beginLlmExchangeSelection(S1);
    expect(oldSignal?.aborted).toBe(true);
    await store.fetchLlmExchange(newToken);
    store.clearLlmExchange(oldToken);
    oldRequest.resolve({ sessionId: S1, exchange: { provider: 'old' } });
    await oldFetch;
    expect(store.currentLlmExchange).toEqual({ provider: 'new' });
  });
});
