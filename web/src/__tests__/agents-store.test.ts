import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAgentStore } from '../stores/agents';

vi.mock('../api/client', () => ({
  listAgentSessions: vi.fn(),
  getAgentConversation: vi.fn(),
  ApiError: class extends Error {
    status: number;
    body: Record<string, unknown>;
    constructor(status: number, message: string, body: Record<string, unknown> = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
    get isUnauthorized(): boolean { return this.status === 401; }
    get isNotFound(): boolean { return this.status === 404; }
  },
}));

import { listAgentSessions, getAgentConversation, ApiError } from '../api/client';

const wsTypeHandlers = new Map<string, Set<(envelope: any) => void>>();
const wsReconnectHandlers = new Set<() => void>();

function fireWsEvent(type: string, content: Record<string, unknown>) {
  const handlers = wsTypeHandlers.get(type);
  if (handlers) {
    for (const h of handlers) h({ type, content });
  }
}

function fireReconnect() {
  for (const h of wsReconnectHandlers) h();
}

vi.mock('../stores/ws', () => ({
  useWsStore: vi.fn(() => ({
    onType: (type: string, handler: (envelope: any) => void) => {
      let set = wsTypeHandlers.get(type);
      if (!set) {
        set = new Set();
        wsTypeHandlers.set(type, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    onReconnect: (handler: () => void) => {
      wsReconnectHandlers.add(handler);
      return () => wsReconnectHandlers.delete(handler);
    },
  })),
}));

function setupStore() {
  setActivePinia(createPinia());
  wsTypeHandlers.clear();
  wsReconnectHandlers.clear();
  return useAgentStore();
}

const mockSession = {
  id: 'session-001',
  role: 'planner' as const,
  goal_card_id: 'goal-1',
  card_id: 'card-1',
  status: 'active' as const,
  started_at: '2025-06-01T08:00:00Z',
  completed_at: null,
  model: 'claude-sonnet-4',
};

const mockMessages = [
  {
    id: 'msg-1',
    session_id: 'session-001',
    role: 'assistant' as const,
    kind: 'text' as const,
    content: 'I will inspect the current plan.',
    tool: undefined,
    timestamp: '2025-06-01T08:00:01Z',
    links: [],
  },
  {
    id: 'msg-2',
    session_id: 'session-001',
    role: 'assistant' as const,
    kind: 'tool_call' as const,
    content: '{"query":"cards"}',
    tool: 'list_cards',
    timestamp: '2025-06-01T08:00:02Z',
    links: [],
  },
  {
    id: 'msg-3',
    session_id: 'session-001',
    role: 'tool' as const,
    kind: 'tool_result' as const,
    content: '{"cards":[]}',
    tool: 'list_cards',
    timestamp: '2025-06-01T08:00:03Z',
    links: [],
  },
  {
    id: 'msg-4',
    session_id: 'session-001',
    role: 'assistant' as const,
    kind: 'model_issue' as const,
    content: 'Retrying after transient issue.',
    tool: undefined,
    timestamp: '2025-06-01T08:00:04Z',
    links: [],
  },
  {
    id: 'msg-5',
    session_id: 'session-001',
    role: 'assistant' as const,
    kind: 'tool_call' as const,
    content: '{"plan":[]}',
    tool: 'create_plan',
    timestamp: '2025-06-01T08:00:05Z',
    links: [],
  },
  {
    id: 'msg-6',
    session_id: 'session-001',
    role: 'tool' as const,
    kind: 'tool_error' as const,
    content: 'rate limited',
    tool: 'create_plan',
    timestamp: '2025-06-01T08:00:06Z',
    links: [],
  },
];

const mockConversationResponse = {
  session: mockSession,
  messages: mockMessages,
};

describe('useAgentStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsTypeHandlers.clear();
    wsReconnectHandlers.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchSessions()', () => {
    it('loads persisted sessions from the API', async () => {
      const store = setupStore();
      vi.mocked(listAgentSessions).mockResolvedValue({ sessions: [mockSession] });

      await store.fetchSessions();

      expect(listAgentSessions).toHaveBeenCalledOnce();
      expect(store.sessions).toEqual([mockSession]);
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
    });

    it('sets API error text when session list fetch fails', async () => {
      const store = setupStore();
      vi.mocked(listAgentSessions).mockRejectedValue(new ApiError(500, 'Failed to list agent sessions', {}));

      await expect(store.fetchSessions()).rejects.toThrow('Failed to list agent sessions');

      expect(store.error).toBe('Failed to list agent sessions');
      expect(store.loading).toBe(false);
    });
  });

  describe('fetchConversation()', () => {
    it('populates currentSession and messages on success', async () => {
      const store = setupStore();
      vi.mocked(getAgentConversation).mockResolvedValue(mockConversationResponse);

      await store.fetchConversation('session-001');

      expect(getAgentConversation).toHaveBeenCalledWith('session-001');
      expect(store.currentSession).toEqual(mockSession);
      expect(store.messages).toEqual(mockMessages);
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
    });

    it('sets generic error text on non-ApiError failures', async () => {
      const store = setupStore();
      vi.mocked(getAgentConversation).mockRejectedValue(new Error('network down'));

      await expect(store.fetchConversation('session-001')).rejects.toThrow('network down');

      expect(store.error).toBe('Failed to fetch agent conversation');
      expect(store.loading).toBe(false);
    });

    it('uses ApiError.message on ApiError failures', async () => {
      const store = setupStore();
      vi.mocked(getAgentConversation).mockRejectedValue(new ApiError(404, 'Agent session not found', {}));

      await expect(store.fetchConversation('session-001')).rejects.toThrow('Agent session not found');

      expect(store.error).toBe('Agent session not found');
      expect(store.loading).toBe(false);
    });
  });

  describe('message grouping and tool expansion', () => {
    it('groups reasoning → tool_call → tool_result into one step, model events standalone', async () => {
      const store = setupStore();
      vi.mocked(getAgentConversation).mockResolvedValue(mockConversationResponse);

      await store.fetchConversation('session-001');

      const steps = store.steps;
      expect(steps).toHaveLength(3);
      expect(steps[0].reasoning?.id).toBe('msg-1');
      expect(steps[0].toolCall?.id).toBe('msg-2');
      expect(steps[0].toolResult?.id).toBe('msg-3');
      expect(steps[1].reasoning?.id).toBe('msg-4');
      expect(steps[1].toolCall).toBeUndefined();
      expect(steps[2].toolCall?.id).toBe('msg-5');
      expect(steps[2].toolResult?.id).toBe('msg-6');
    });

    it('toggles and expands tool messages correctly', async () => {
      const store = setupStore();
      vi.mocked(getAgentConversation).mockResolvedValue(mockConversationResponse);

      await store.fetchConversation('session-001');

      store.toggleToolCall('msg-2');
      expect(store.expandedToolCalls.has('msg-2')).toBe(true);

      store.toggleToolCall('msg-2');
      expect(store.expandedToolCalls.has('msg-2')).toBe(false);

      store.expandAll();
      expect(Array.from(store.expandedToolCalls).sort()).toEqual(['msg-2', 'msg-3', 'msg-5', 'msg-6']);

      store.collapseAll();
      expect(store.expandedToolCalls.size).toBe(0);
    });
  });

  describe('setupWsListener()', () => {
    it('registers one handler each for status, thinking, and activity', () => {
      const store = setupStore();

      store.setupWsListener();

      expect(wsTypeHandlers.get('status')?.size).toBe(1);
      expect(wsTypeHandlers.get('thinking')?.size).toBe(1);
      expect(wsTypeHandlers.get('activity')?.size).toBe(1);
      expect(wsReconnectHandlers.size).toBe(1);
    });

    it('is idempotent — repeated setupWsListener does not duplicate any handler', () => {
      const store = setupStore();

      store.setupWsListener();
      expect(wsTypeHandlers.get('status')?.size).toBe(1);
      expect(wsTypeHandlers.get('thinking')?.size).toBe(1);
      expect(wsTypeHandlers.get('activity')?.size).toBe(1);
      expect(wsReconnectHandlers.size).toBe(1);

      store.setupWsListener();
      expect(wsTypeHandlers.get('status')?.size).toBe(1);
      expect(wsTypeHandlers.get('thinking')?.size).toBe(1);
      expect(wsTypeHandlers.get('activity')?.size).toBe(1);
      expect(wsReconnectHandlers.size).toBe(1);

      store.setupWsListener();
      expect(wsTypeHandlers.get('status')?.size).toBe(1);
      expect(wsTypeHandlers.get('thinking')?.size).toBe(1);
      expect(wsTypeHandlers.get('activity')?.size).toBe(1);
      expect(wsReconnectHandlers.size).toBe(1);
    });

    it('fires each handler exactly once per event even after repeated setupWsListener calls', () => {
      const store = setupStore();

      store.setupWsListener();
      store.setupWsListener();
      store.setupWsListener();

      fireWsEvent('status', { event: 'agent-session-started', session: mockSession });
      expect(store.sessions).toHaveLength(1);
      expect(store.sessions[0].id).toBe('session-001');
    });

    it('allows thinking/activity handlers to append messages only for current session', () => {
      const store = setupStore();
      store.setupWsListener();
      store.currentSession = { ...mockSession };
      store.messages = [];

      const thinkingMessage = {
        id: 'think-1',
        session_id: 'session-001',
        role: 'assistant' as const,
        kind: 'activity' as const,
        content: 'Thinking...',
        tool: undefined,
        timestamp: '2025-06-01T08:10:00Z',
        links: [],
      };

      const activityMessage = {
        id: 'act-1',
        session_id: 'session-001',
        role: 'assistant' as const,
        kind: 'activity' as const,
        content: 'Using tool...',
        tool: undefined,
        timestamp: '2025-06-01T08:10:01Z',
        links: [],
      };

      const otherSessionMessage = {
        ...activityMessage,
        id: 'act-2',
        session_id: 'session-999',
      };

      fireWsEvent('thinking', { sessionId: 'session-001', message: thinkingMessage });
      fireWsEvent('activity', { sessionId: 'session-001', message: activityMessage });
      fireWsEvent('activity', { sessionId: 'session-999', message: otherSessionMessage });

      expect(store.messages.map((m) => m.id)).toEqual(['think-1', 'act-1']);
    });

    it('updates sessions from agent session lifecycle status events', () => {
      const store = setupStore();
      store.setupWsListener();

      fireWsEvent('status', { event: 'agent-session-started', session: mockSession });
      expect(store.sessions).toHaveLength(1);
      expect(store.sessions[0].status).toBe('active');

      fireWsEvent('status', { event: 'agent-session-completed', sessionId: 'session-001' });
      expect(store.sessions[0].status).toBe('done');

      fireWsEvent('status', { event: 'agent-session-failed', sessionId: 'session-001' });
      expect(store.sessions[0].status).toBe('failed');
    });

    it('isolates listener state between separate Pinia instances', () => {
      setActivePinia(createPinia());
      wsTypeHandlers.clear();
      wsReconnectHandlers.clear();
      const store1 = useAgentStore();
      store1.setupWsListener();

      setActivePinia(createPinia());
      const store2 = useAgentStore();
      store2.setupWsListener();

      expect(wsTypeHandlers.get('status')?.size).toBe(2);
      expect(wsTypeHandlers.get('thinking')?.size).toBe(2);
      expect(wsTypeHandlers.get('activity')?.size).toBe(2);
      expect(wsReconnectHandlers.size).toBe(2);

      store1.setupWsListener();
      store2.setupWsListener();
      expect(wsTypeHandlers.get('status')?.size).toBe(2);
    });

    it('preserves event delivery to all registered store instances', () => {
      setActivePinia(createPinia());
      wsTypeHandlers.clear();
      wsReconnectHandlers.clear();
      const store1 = useAgentStore();
      store1.setupWsListener();
      store1.currentSession = { ...mockSession };
      store1.messages = [];

      setActivePinia(createPinia());
      const store2 = useAgentStore();
      store2.setupWsListener();
      store2.currentSession = { ...mockSession, id: 'session-002' };
      store2.messages = [];

      fireWsEvent('status', { event: 'agent-session-started', session: { ...mockSession, id: 'session-002' } });

      expect(store1.sessions).toHaveLength(1);
      expect(store1.sessions[0].id).toBe('session-002');
      expect(store2.sessions).toHaveLength(1);
      expect(store2.sessions[0].id).toBe('session-002');
    });

    it('refreshes sessions and the active conversation on reconnect', async () => {
      const store = setupStore();
      store.currentSession = { ...mockSession };
      vi.mocked(listAgentSessions).mockResolvedValue({ sessions: [mockSession] });
      vi.mocked(getAgentConversation).mockResolvedValue(mockConversationResponse);

      store.setupWsListener();
      fireReconnect();
      await Promise.resolve();
      await Promise.resolve();

      expect(listAgentSessions).toHaveBeenCalledOnce();
      expect(getAgentConversation).toHaveBeenCalledWith('session-001');
    });
  });
});
