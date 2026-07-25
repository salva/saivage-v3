import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCardAgentSessions, listAgentSessions } from '../api/client';
import { useAgentStore } from '../stores/agents';

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly body: Record<string, unknown> = {},
    ) {
      super(message);
    }
    get isNotFound() {
      return this.status === 404;
    }
    get isUnauthorized() {
      return this.status === 401;
    }
  },
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
  card_id: null,
  started_at: '2026-07-24T00:00:00.000Z',
};
const currentCardSession = {
  id: 'agent:planner:card-a' as const,
  agent_name: 'planner' as const,
  session_scope: 'card' as const,
  card_id: 'card-a' as const,
  started_at: '2026-07-24T00:00:01.000Z',
};
const staleCardSession = { ...currentCardSession, started_at: '2026-07-23T00:00:00.000Z' };

describe('Agent membership authority races', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(listAgentSessions).mockReset();
    vi.mocked(getCardAgentSessions).mockReset();
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
});
