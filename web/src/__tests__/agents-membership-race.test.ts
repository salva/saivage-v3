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
    reconfigure: vi.fn(),
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
