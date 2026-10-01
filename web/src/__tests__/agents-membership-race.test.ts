import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSyncInvalidateFrame, LiveSyncSubscribedFrame, WsConnectionState } from '../api/types';
import type { WsConnectionManager, WsSyncFrameHandler } from '../api/websocket';
import { getAgentConversation, getAgentSession, getCardAgentSessions, listAgentSessions } from '../api/client';
import { useAgentStore } from '../stores/agents';
import { SyncClient } from '../sync/client';

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getAgentConversation: vi.fn(),
  getAgentLlmExchange: vi.fn(),
  getAgentSession: vi.fn(),
  getCardAgentSessions: vi.fn(),
  listAgentSessions: vi.fn(),
}));

const analyst = {
  id: 'agent:analyst:global' as const,
  agent_name: 'analyst' as const,
  session_scope: 'global' as const,
  compaction: null,
  card_id: null,
  started_at: '2026-07-24T00:00:00.000Z',
  status: 'inactive' as const,
  activity: 'idle' as const,
};
const currentCardSession = {
  id: 'agent:planner:card-a' as const,
  agent_name: 'planner' as const,
  session_scope: 'card' as const,
  compaction: null,
  card_id: 'card-a' as const,
  started_at: '2026-07-24T00:00:01.000Z',
  status: 'active' as const,
  activity: 'busy' as const,
};
const staleCardSession = { ...currentCardSession, started_at: '2026-07-23T00:00:00.000Z' };
const oversight = {
  ...analyst,
  id: 'agent:oversight:global' as const,
  agent_name: 'oversight' as const,
};
const globalHint = (session_id: typeof analyst.id | typeof oversight.id) => ({
  t: 'invalidate', resource: 'agent-membership', scope: 'global-session', session_id,
} as const);
const cardBSession = {
  ...currentCardSession,
  id: 'agent:executor:card-b' as const,
  agent_name: 'executor' as const,
  card_id: 'card-b' as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function connectionHarness() {
  let sync: WsSyncFrameHandler = () => {};
  const conn = {
    state: { value: 'connected' as WsConnectionState },
    connect: vi.fn(),
    sendRaw: vi.fn((_payload: unknown) => true),
    onEvent: vi.fn(() => () => {}),
    onState: vi.fn(() => () => {}),
    onOpen: vi.fn(() => () => {}),
    onSyncFrame: vi.fn((handler) => {
      sync = handler;
      return () => {};
    }),
  } satisfies WsConnectionManager;
  return {
    client: new SyncClient(conn),
    conn,
    emit(frame: LiveSyncInvalidateFrame | LiveSyncSubscribedFrame) { sync(frame); },
  };
}

describe('Agent membership authority races', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(listAgentSessions).mockReset();
    vi.mocked(getAgentSession).mockReset();
    vi.mocked(getCardAgentSessions).mockReset();
    vi.mocked(getAgentConversation).mockReset();
  });

  it.each(['analyst-first', 'oversight-first'] as const)('merges independent global updates (%s) without dropping siblings', async (order) => {
    const a = deferred<{ session: typeof analyst }>();
    const o = deferred<{ session: typeof oversight }>();
    const updatedAnalyst = { ...analyst, started_at: '2026-10-01T00:00:00.000Z' };
    const updatedOversight = { ...oversight, started_at: '2026-10-01T00:00:01.000Z' };
    vi.mocked(listAgentSessions).mockResolvedValueOnce({ sessions: [analyst, oversight, currentCardSession] });
    vi.mocked(getAgentSession).mockReturnValueOnce(a.promise).mockReturnValueOnce(o.promise);
    const store = useAgentStore();
    await store.fetchSessions();
    const updateA = store.reconcileMembership(globalHint(analyst.id));
    const updateO = store.reconcileMembership(globalHint(oversight.id));
    expect(vi.mocked(getAgentSession).mock.calls.map(([, signal]) => signal?.aborted)).toEqual([false, false]);
    if (order === 'analyst-first') {
      a.resolve({ session: updatedAnalyst }); await updateA;
      expect(store.sessions).toContainEqual(oversight);
      o.resolve({ session: updatedOversight }); await updateO;
    } else {
      o.resolve({ session: updatedOversight }); await updateO;
      expect(store.sessions).toContainEqual(analyst);
      a.resolve({ session: updatedAnalyst }); await updateA;
    }
    expect(store.sessions).toEqual([updatedAnalyst, updatedOversight, currentCardSession].sort((x, y) => x.id.localeCompare(y.id)));
  });

  it('inserts a newly observed global sibling and retains latest-request wins for its exact identity', async () => {
    const stale = deferred<{ session: typeof oversight }>();
    const updated = { ...oversight, started_at: '2026-10-01T00:00:00.000Z' };
    vi.mocked(listAgentSessions).mockResolvedValueOnce({ sessions: [analyst] });
    vi.mocked(getAgentSession).mockReturnValueOnce(stale.promise).mockResolvedValueOnce({ session: updated });
    const store = useAgentStore();
    await store.fetchSessions();
    const old = store.reconcileMembership(globalHint(oversight.id));
    await store.reconcileMembership(globalHint(oversight.id));
    expect(vi.mocked(getAgentSession).mock.calls[0]![1]?.aborted).toBe(true);
    stale.resolve({ session: oversight }); await old;
    expect(store.sessions).toEqual([analyst, updated]);
  });

  it('fences both outstanding global responses with a full baseline and keeps siblings on detail failure', async () => {
    const a = deferred<{ session: typeof analyst }>();
    const o = deferred<{ session: typeof oversight }>();
    vi.mocked(listAgentSessions).mockResolvedValueOnce({ sessions: [analyst] }).mockResolvedValueOnce({ sessions: [analyst, oversight] });
    vi.mocked(getAgentSession).mockReturnValueOnce(a.promise).mockReturnValueOnce(o.promise);
    const store = useAgentStore(); await store.fetchSessions();
    const updateA = store.reconcileMembership(globalHint(analyst.id));
    const updateO = store.reconcileMembership(globalHint(oversight.id));
    await store.fetchSessions();
    expect(vi.mocked(getAgentSession).mock.calls.map(([, signal]) => signal?.aborted)).toEqual([true, true]);
    a.resolve({ session: { ...analyst, started_at: 'stale' } });
    o.resolve({ session: { ...oversight, started_at: 'stale' } });
    await Promise.all([updateA, updateO]);
    expect(store.sessions).toEqual([analyst, oversight]);
    vi.mocked(getAgentSession).mockRejectedValueOnce(new Error('detail failed'));
    await expect(store.reconcileMembership(globalHint(oversight.id))).rejects.toThrow('detail failed');
    expect(store.sessions).toEqual([analyst, oversight]);
  });

  it('fences a global hint started while the replacement baseline is pending', async () => {
    const baseline = deferred<{ sessions: [typeof analyst, typeof oversight] }>();
    const detail = deferred<{ session: typeof oversight }>();
    vi.mocked(listAgentSessions).mockResolvedValueOnce({ sessions: [analyst] }).mockReturnValueOnce(baseline.promise);
    vi.mocked(getAgentSession).mockReturnValueOnce(detail.promise);
    const store = useAgentStore(); await store.fetchSessions();
    const replacement = store.fetchSessions();
    const update = store.reconcileMembership(globalHint(oversight.id));
    baseline.resolve({ sessions: [analyst, oversight] }); await replacement;
    expect(vi.mocked(getAgentSession).mock.calls[0]![1]?.aborted).toBe(true);
    detail.resolve({ session: { ...oversight, started_at: '2026-09-01T00:00:00.000Z' } }); await update;
    expect(store.sessions).toEqual([analyst, oversight]);
  });

  it('does not let a pre-reconnect card reconciliation overwrite the accepted baseline', async () => {
    vi.mocked(listAgentSessions)
      .mockResolvedValueOnce({ sessions: [analyst] })
      .mockResolvedValueOnce({ sessions: [analyst, currentCardSession] });
    let resolveStale!: (value: { card_id: 'card-a'; sessions: [typeof staleCardSession] }) => void;
    vi.mocked(getCardAgentSessions).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStale = resolve;
      }),
    );
    const store = useAgentStore();

    await store.fetchSessions();
    const stalePatch = store.reconcileMembership({
      t: 'invalidate',
      resource: 'agent-membership',
      scope: 'card',
      card_id: 'card-a',
    });
    await store.fetchSessions();
    resolveStale({ card_id: 'card-a', sessions: [staleCardSession] });
    await stalePatch;

    expect(store.sessions).toEqual([analyst, currentCardSession]);
  });

  it('preserves selected-summary and both inventory scopes when held B receives pending A then B', async () => {
    const heldB = deferred<{ card_id: 'card-b'; sessions: [typeof cardBSession] }>();
    const compactingA = {
      ...currentCardSession,
      compaction: {
        strategy: 'preventive' as const,
        started_at: '2026-09-09T10:00:00.000Z',
        folds_done: 2,
        fold_in_flight: true,
      },
    };
    const currentA = { ...currentCardSession, started_at: '2026-09-09T11:00:00.000Z' };
    const currentB = { ...cardBSession, started_at: '2026-09-09T11:00:01.000Z' };
    vi.mocked(getAgentSession)
      .mockResolvedValueOnce({ session: compactingA })
      .mockResolvedValueOnce({ session: compactingA })
      .mockResolvedValueOnce({ session: currentA });
    vi.mocked(listAgentSessions)
      .mockResolvedValueOnce({ sessions: [staleCardSession, cardBSession] })
      .mockResolvedValueOnce({ sessions: [currentA, currentB] });
    vi.mocked(getCardAgentSessions)
      .mockReturnValueOnce(heldB.promise)
      .mockResolvedValue({ card_id: 'card-b', sessions: [currentB] });

    const store = useAgentStore();
    const token = store.beginConversationSelection(currentCardSession.id);
    await store.fetchSelectedSession(token);
    expect(store.currentSession?.compaction).toEqual(compactingA.compaction);

    const h = connectionHarness();
    h.client.start();
    h.client.openAgents((frame) => store.reconcileMembership(frame));
    const subscribe = vi.mocked(h.conn.sendRaw).mock.calls[0]![0] as { lease: string };
    h.emit({ t: 'subscribed', resource: 'agents', lease: subscribe.lease });
    await vi.waitFor(() => expect(listAgentSessions).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(getAgentSession).toHaveBeenCalledTimes(2));
    expect(store.currentSession?.compaction).toEqual(compactingA.compaction);

    const frameB = { t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-b' } as const;
    h.emit(frameB);
    await vi.waitFor(() => expect(getCardAgentSessions).toHaveBeenCalledWith('card-b', expect.any(AbortSignal)));
    h.emit({ t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-a' });
    h.emit(frameB);
    expect(listAgentSessions).toHaveBeenCalledTimes(1);

    heldB.resolve({ card_id: 'card-b', sessions: [currentB] });
    await vi.waitFor(() => expect(listAgentSessions).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.currentSession?.compaction).toBeNull());

    expect(store.sessions).toEqual([currentA, currentB].sort((a, b) => a.id.localeCompare(b.id)));
    expect(getAgentSession).toHaveBeenCalledTimes(3);
    expect(getAgentSession).toHaveBeenNthCalledWith(1, currentCardSession.id, expect.any(AbortSignal));
    expect(getAgentSession).toHaveBeenNthCalledWith(2, currentCardSession.id, expect.any(AbortSignal));
    expect(getAgentSession).toHaveBeenLastCalledWith(currentCardSession.id, expect.any(AbortSignal));
    expect(getAgentConversation).not.toHaveBeenCalled();
  });
});
