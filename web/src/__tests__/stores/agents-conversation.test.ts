import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ActivityStatus, AgentSession } from '../../api/types';
import { useAgentStore } from '../../stores/agents';

vi.mock('../../api/client', () => ({
  listAgentSessions: vi.fn(),
  getAgentConversation: vi.fn(),
  getAgentLlmExchange: vi.fn(),
  ApiError: class extends Error {
    constructor(public status: number, message: string) { super(message); }
    get isUnauthorized() { return this.status === 401; }
    get isNotFound() { return this.status === 404; }
  },
}));

import { ApiError, getAgentConversation, getAgentLlmExchange, listAgentSessions } from '../../api/client';

const S1 = 'planner:project' as const;
const S2 = 'reviewer:project' as const;
const session: AgentSession = { id: S1, role: 'planner', status: 'active', started_at: '2026-01-01T00:00:00.000Z' };
const entry = { id: 'm1', session_id: S1, role: 'assistant', kind: 'text', content: 'hello', round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: '2026-01-01T00:00:01.000Z' } as const;
const activityStatus: ActivityStatus = { status: 'inactive', pending_calls: [] };
const exchange = { provider: 'provider-one' } as any;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useAgentStore singular agent resource ownership', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('treats an accepted empty session list as loaded and preserves it on refresh failure', async () => {
    vi.mocked(listAgentSessions)
      .mockResolvedValueOnce({ sessions: [] })
      .mockRejectedValueOnce(new ApiError(500, 'refresh failed', {}));
    const store = useAgentStore();

    await store.fetchSessions();
    expect(store.sessionsLoaded).toBe(true);
    expect(store.sessions).toEqual([]);

    const refresh = store.fetchSessions();
    expect(store.sessionsLoading).toBe(false);
    expect(store.sessionsRefreshing).toBe(true);
    await expect(refresh).rejects.toThrow('refresh failed');
    expect(store.sessions).toEqual([]);
    expect(store.sessionsError).toBeNull();
    expect(store.sessionsRefreshError).toBe('refresh failed');
  });

  it('keeps list, conversation, and exchange request state independent', async () => {
    const list = deferred<{ sessions: AgentSession[] }>();
    const conversation = deferred<any>();
    const raw = deferred<any>();
    vi.mocked(listAgentSessions).mockReturnValue(list.promise);
    vi.mocked(getAgentConversation).mockReturnValue(conversation.promise);
    vi.mocked(getAgentLlmExchange).mockReturnValue(raw.promise);
    const store = useAgentStore();
    const conversationToken = store.beginConversationSelection(S1);
    const exchangeToken = store.beginLlmExchangeSelection(S1);

    const listRequest = store.fetchSessions();
    const conversationRequest = store.fetchConversation(conversationToken);
    const exchangeRequest = store.fetchLlmExchange(exchangeToken);
    expect(store.sessionsLoading).toBe(true);
    expect(store.conversationLoading).toBe(true);
    expect(store.llmExchangeLoading).toBe(true);

    list.resolve({ sessions: [session] });
    conversation.resolve({ session, entries: [entry], activity_status: activityStatus });
    raw.resolve({ sessionId: S1, exchange });
    await Promise.all([listRequest, conversationRequest, exchangeRequest]);
    expect(store.sessionsLoaded).toBe(true);
    expect(store.currentSession?.id).toBe(S1);
    expect(store.currentLlmExchange).toEqual(exchange);
  });

  it('aborts a superseded list request and rejects its late completion', async () => {
    const oldRequest = deferred<{ sessions: AgentSession[] }>();
    let oldSignal: AbortSignal | undefined;
    vi.mocked(listAgentSessions)
      .mockImplementationOnce((signal) => { oldSignal = signal; return oldRequest.promise; })
      .mockResolvedValueOnce({ sessions: [{ id: S2, role: 'reviewer', status: 'active', started_at: session.started_at }] });
    const store = useAgentStore();
    const oldFetch = store.fetchSessions();
    await store.fetchSessions();
    expect(oldSignal?.aborted).toBe(true);
    oldRequest.resolve({ sessions: [session] });
    await oldFetch;
    expect(store.sessions.map(({ id }) => id)).toEqual([S2]);
    expect(store.sessionsLoading).toBe(false);
  });

  it('gates aggregate triggers, ignores stale bootstrap tokens, and finishes the current token exactly once', async () => {
    vi.mocked(listAgentSessions).mockResolvedValue({ sessions: [session] });
    const store = useAgentStore();
    const stale = store.beginSessionsBootstrap();

    await expect(store.fetchSessions()).resolves.toBe(false);
    expect(listAgentSessions).not.toHaveBeenCalled();

    const current = store.beginSessionsBootstrap();
    await store.finishSessionsBootstrap(stale);
    expect(listAgentSessions).not.toHaveBeenCalled();

    await store.finishSessionsBootstrap(current);
    await store.finishSessionsBootstrap(current);
    expect(listAgentSessions).toHaveBeenCalledTimes(1);
    expect(store.sessions).toEqual([session]);
  });

  it('synchronously aborts and sequence-supersedes a pending aggregate while preserving accepted stale data', async () => {
    const pending = deferred<{ sessions: AgentSession[] }>();
    let signal: AbortSignal | undefined;
    vi.mocked(listAgentSessions)
      .mockResolvedValueOnce({ sessions: [session] })
      .mockImplementationOnce((requestSignal) => { signal = requestSignal; return pending.promise; });
    const store = useAgentStore();
    await expect(store.fetchSessions()).resolves.toBe(true);
    const old = store.fetchSessions();
    expect(store.sessionsRefreshing).toBe(true);

    store.beginSessionsBootstrap();
    expect(signal?.aborted).toBe(true);
    expect(store.sessionsLoading).toBe(false);
    expect(store.sessionsRefreshing).toBe(false);
    expect(store.sessions).toEqual([session]);

    pending.resolve({ sessions: [{ id: S2, role: 'reviewer', status: 'active', started_at: session.started_at }] });
    await expect(old).resolves.toBe(false);
    expect(store.sessions).toEqual([session]);
  });

  it('makes a superseded late aggregate failure inert and returns true for a normal post-gate refresh', async () => {
    const pending = deferred<{ sessions: AgentSession[] }>();
    vi.mocked(listAgentSessions)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ sessions: [session] });
    const store = useAgentStore();
    const old = store.fetchSessions();
    const token = store.beginSessionsBootstrap();
    pending.reject(new Error('late failure'));
    await expect(old).resolves.toBe(false);
    expect(store.sessionsError).toBeNull();

    await store.finishSessionsBootstrap(token);
    expect(store.sessions).toEqual([session]);
    await expect(store.fetchSessions()).resolves.toBe(true);
    expect(listAgentSessions).toHaveBeenCalledTimes(3);
  });

  it('retains accepted conversation data and records only a same-session refresh error', async () => {
    vi.mocked(getAgentConversation)
      .mockResolvedValueOnce({ session, entries: [entry], activity_status: activityStatus })
      .mockRejectedValueOnce(new ApiError(500, 'conversation refresh failed', {}));
    const store = useAgentStore();
    const token = store.beginConversationSelection(S1);
    await store.fetchConversation(token);

    const refresh = store.refetchConversation(token);
    expect(store.conversationRefreshing).toBe(true);
    expect(store.entries).toEqual([entry]);
    await expect(refresh).rejects.toThrow('conversation refresh failed');
    expect(store.entries).toEqual([entry]);
    expect(store.conversationError).toBeNull();
    expect(store.conversationRefreshError).toBe('conversation refresh failed');
  });

  it('rejects a successful conversation response for the wrong session identity', async () => {
    vi.mocked(getAgentConversation).mockResolvedValue({ session: { id: S2, role: 'reviewer', status: 'active', started_at: session.started_at }, entries: [], activity_status: activityStatus });
    const store = useAgentStore();
    const token = store.beginConversationSelection(S1);
    await expect(store.fetchConversation(token)).rejects.toThrow(`does not match selected session ${S1}`);
    expect(store.currentSession).toBeNull();
  });

  it('makes stale conversation tokens, completions, refetches, and clears unable to affect a newer claim', async () => {
    const oldRequest = deferred<any>();
    vi.mocked(getAgentConversation)
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({ session: { id: S2, role: 'reviewer', status: 'active', started_at: session.started_at }, entries: [{ ...entry, session_id: S2, content: 'new' }], activity_status: activityStatus });
    const store = useAgentStore();
    const oldToken = store.beginConversationSelection(S1);
    const oldFetch = store.fetchConversation(oldToken);
    const newToken = store.beginConversationSelection(S2);
    await store.fetchConversation(newToken);

    await store.refetchConversation(oldToken);
    store.clearConversationSelection(oldToken);
    oldRequest.resolve({ session, entries: [entry], activity_status: activityStatus });
    await oldFetch;
    expect(getAgentConversation).toHaveBeenCalledTimes(2);
    expect(store.currentSession?.id).toBe(S2);
    expect(store.entries[0]?.content).toBe('new');
    expect(store.conversationLoading).toBe(false);
  });

  it('protects a newer same-session conversation claim from an old cleanup', async () => {
    vi.mocked(getAgentConversation).mockResolvedValue({ session, entries: [entry], activity_status: activityStatus });
    const store = useAgentStore();
    const oldToken = store.beginConversationSelection(S1);
    const newToken = store.beginConversationSelection(S1);
    store.clearConversationSelection(oldToken);
    await store.fetchConversation(newToken);
    expect(store.currentSession?.id).toBe(S1);
  });

  it('clear aborts and epoch-invalidates an in-flight conversation before late completion', async () => {
    const request = deferred<any>();
    let signal: AbortSignal | undefined;
    vi.mocked(getAgentConversation).mockImplementation((_id, requestSignal) => {
      signal = requestSignal;
      return request.promise;
    });
    const store = useAgentStore();
    const token = store.beginConversationSelection(S1);
    const fetch = store.fetchConversation(token);
    store.clearConversationSelection(token);
    expect(signal?.aborted).toBe(true);
    request.resolve({ session, entries: [entry], activity_status: activityStatus });
    await fetch;
    expect(store.selectedConversationSessionId).toBeNull();
    expect(store.currentSession).toBeNull();
    expect(store.conversationLoading).toBe(false);
  });

  it('accepts an initial exchange 404 as loaded empty without errors', async () => {
    vi.mocked(getAgentLlmExchange).mockRejectedValue(new ApiError(404, 'missing', {}));
    const store = useAgentStore();
    const token = store.beginLlmExchangeSelection(S1);
    await store.fetchLlmExchange(token);
    expect(store.llmExchangeLoaded).toBe(true);
    expect(store.currentLlmExchange).toBeNull();
    expect(store.llmExchangeError).toBeNull();
    expect(store.llmExchangeRefreshError).toBeNull();
  });

  it('treats a refresh 404 as authoritative empty and clears a prior exchange and both errors', async () => {
    vi.mocked(getAgentLlmExchange)
      .mockResolvedValueOnce({ sessionId: S1, exchange })
      .mockRejectedValueOnce(new ApiError(404, 'missing', {}));
    const store = useAgentStore();
    const token = store.beginLlmExchangeSelection(S1);
    await store.fetchLlmExchange(token);
    await store.fetchLlmExchange(token);
    expect(store.llmExchangeLoaded).toBe(true);
    expect(store.currentLlmExchange).toBeNull();
    expect(store.llmExchangeError).toBeNull();
    expect(store.llmExchangeRefreshError).toBeNull();
  });

  it('records only an initial exchange non-404 error and leaves the identity unloaded', async () => {
    vi.mocked(getAgentLlmExchange).mockRejectedValue(new ApiError(500, 'exchange failed', {}));
    const store = useAgentStore();
    const token = store.beginLlmExchangeSelection(S1);
    await store.fetchLlmExchange(token);
    expect(store.llmExchangeLoaded).toBe(false);
    expect(store.currentLlmExchange).toBeNull();
    expect(store.llmExchangeError).toBe('exchange failed');
    expect(store.llmExchangeRefreshError).toBeNull();
  });

  it.each([
    ['accepted exchange', { sessionId: S1, exchange }, exchange],
    ['accepted empty result', new ApiError(404, 'missing', {}), null],
  ])('retains an %s on a same-identity non-404 refresh failure', async (_label, firstResult, expected) => {
    if (firstResult instanceof Error) vi.mocked(getAgentLlmExchange).mockRejectedValueOnce(firstResult);
    else vi.mocked(getAgentLlmExchange).mockResolvedValueOnce(firstResult);
    vi.mocked(getAgentLlmExchange).mockRejectedValueOnce(new ApiError(500, 'refresh failed', {}));
    const store = useAgentStore();
    const token = store.beginLlmExchangeSelection(S1);
    await store.fetchLlmExchange(token);
    await store.fetchLlmExchange(token);
    expect(store.llmExchangeLoaded).toBe(true);
    expect(store.currentLlmExchange).toEqual(expected);
    expect(store.llmExchangeError).toBeNull();
    expect(store.llmExchangeRefreshError).toBe('refresh failed');
  });

  it('aborts and rejects late exchange completion and stale same-session cleanup', async () => {
    const oldRequest = deferred<any>();
    let oldSignal: AbortSignal | undefined;
    vi.mocked(getAgentLlmExchange)
      .mockImplementationOnce((_id, signal) => { oldSignal = signal; return oldRequest.promise; })
      .mockResolvedValueOnce({ sessionId: S1, exchange: { provider: 'new' } as any });
    const store = useAgentStore();
    const oldToken = store.beginLlmExchangeSelection(S1);
    const oldFetch = store.fetchLlmExchange(oldToken);
    const newToken = store.beginLlmExchangeSelection(S1);
    expect(oldSignal?.aborted).toBe(true);
    await store.fetchLlmExchange(newToken);
    store.clearLlmExchange(oldToken);
    oldRequest.resolve({ sessionId: S1, exchange: { provider: 'old' } });
    await oldFetch;
    expect(store.currentLlmExchange).toEqual({ provider: 'new' });
    expect(store.llmExchangeLoading).toBe(false);
  });
});
