/**
 * Bounded client-layer regression tests for the runtime Pinia store.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ref } from 'vue';
import { useRuntimeStore } from '../stores/runtime';

vi.mock('../api/client', () => ({
  getRuntimeState: vi.fn(),
  pauseRuntime: vi.fn(),
  resumeRuntime: vi.fn(),
  startProject: vi.fn(),
  stopProject: vi.fn(),
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

vi.mock('../api/auth', () => ({
  getAuthToken: vi.fn(() => 'test-token'),
}));

import { getRuntimeState, pauseRuntime, resumeRuntime, startProject, stopProject } from '../api/client';

const wsTypeHandlers = new Map<string, Set<(envelope: any) => void>>();
const reconnectHandlers = new Set<() => void>();
const wsState = {
  connectionState: ref('connected'),
  stale: ref(false),
};

function fireWsEvent(type: string, content: Record<string, unknown>) {
  const handlers = wsTypeHandlers.get(type);
  if (handlers) {
    for (const h of handlers) {
      h({ type, content });
    }
  }
}

function fireReconnect() {
  for (const handler of reconnectHandlers) {
    handler();
  }
}

vi.mock('../stores/ws', () => ({
  useWsStore: vi.fn(() => ({
    get connectionState() { return wsState.connectionState.value; },
    get stale() { return wsState.stale.value; },
    onType: (type: string, handler: (envelope: any) => void) => {
      let set = wsTypeHandlers.get(type);
      if (!set) {
        set = new Set();
        wsTypeHandlers.set(type, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    onReconnect: (handler: () => void) => {
      reconnectHandlers.add(handler);
      return () => reconnectHandlers.delete(handler);
    },
  })),
}));

function setupStore() {
  setActivePinia(createPinia());
  wsTypeHandlers.clear();
  reconnectHandlers.clear();
  wsState.connectionState.value = 'connected';
  wsState.stale.value = false;
  return useRuntimeStore();
}

const mockRuntimeState = {
  status: 'running' as const,
  project_id: 'project' as const,
  pid: 1234,
  started_at: '2025-06-01T08:00:00Z',
  current_card_id: 'card-001',
  current_agent_session_id: 'session-abc',
  paused: false,
  paused_at: null,
  queue: ['card-002', 'card-003'],
  running_processes: ['proc-1', 'proc-2', 'proc-3'],
  updated_at: '2025-06-01T10:00:00Z',
  runtime_intent: { status: 'stopped' as const, updated_at: '2025-06-01T10:00:00Z', source_command_id: null, reason: null },
  runtime_commands: [],
  runtime_runs: [],
  runtime_activations: [],
};

const mockIntent = {
  status: 'running' as const,
  updated_at: '2025-06-01T10:00:00Z',
  source_command_id: 'cmd-1',
  reason: null,
};

const mockCommand = {
  command_id: 'cmd-1',
  command: 'start_project' as const,
  status: 'completed' as const,
  requested_at: '2025-06-01T09:59:00Z',
  completed_at: '2025-06-01T10:00:00Z',
  source: 'operator' as const,
  error: null,
};

const mockStopIntent = {
  status: 'stopped' as const,
  updated_at: '2025-06-01T10:05:00Z',
  source_command_id: 'cmd-2',
  reason: 'operator_stop',
};

const mockStopCommand = {
  command_id: 'cmd-2',
  command: 'stop_project' as const,
  status: 'completed' as const,
  requested_at: '2025-06-01T10:04:00Z',
  completed_at: '2025-06-01T10:05:00Z',
  source: 'operator' as const,
  error: null,
};

const mockRootRun = {
  run_id: 'run-root',
  kind: 'root' as const,
  card_id: 'project',
  parent_run_id: null,
  command_id: 'cmd-1',
  activation_id: null,
  phase: 'planner' as const,
  runtime_status: 'running' as const,
  session_id: 'session-root',
  started_at: '2025-06-01T10:00:00Z',
  updated_at: '2025-06-01T10:01:00Z',
  finished_at: null,
  result: null,
};

const mockStoppedRootRun = {
  ...mockRootRun,
  command_id: 'cmd-2',
  phase: 'stopped' as const,
  runtime_status: 'stopped' as const,
  updated_at: '2025-06-01T10:05:00Z',
  finished_at: '2025-06-01T10:05:00Z',
  result: 'stopped' as const,
};

const mockChildRun = {
  run_id: 'run-child',
  kind: 'child' as const,
  card_id: 'card-002',
  parent_run_id: 'run-root',
  command_id: null,
  activation_id: 'act-1',
  phase: 'executor' as const,
  runtime_status: 'running' as const,
  session_id: 'session-child',
  started_at: '2025-06-01T10:02:00Z',
  updated_at: '2025-06-01T10:03:00Z',
  finished_at: null,
  result: null,
};

const mockActivation = {
  activation_id: 'act-1',
  idempotency_key: 'idem-1',
  parent_card_id: 'project',
  parent_run_id: 'run-root',
  parent_session_id: 'session-root',
  parent_tool_call_id: 'tool-1',
  child_card_id: 'card-002',
  status: 'running' as const,
  requested_at: '2025-06-01T10:02:00Z',
  updated_at: '2025-06-01T10:03:00Z',
  precondition: 'accepted' as const,
  runtime_run_id: 'run-child',
  error: null,
};

const mockActionableError = {
  code: 'runtime_already_running',
  message: 'Project runtime is already running.',
  nextAction: 'Use stop_project before starting again.',
  runId: 'run-root',
};

const mockRuntimeStateWithSummary = {
  ...mockRuntimeState,
  runtime_intent: mockIntent,
  runtime_commands: [mockCommand],
  runtime_runs: [mockRootRun, mockChildRun],
  runtime_activations: [mockActivation],
};

const mockRuntimeStateIdle = {
  status: 'idle' as const,
  project_id: 'project' as const,
  pid: 1234,
  started_at: '2025-06-01T08:00:00Z',
  current_card_id: null,
  current_agent_session_id: null,
  paused: false,
  paused_at: null,
  queue: [],
  running_processes: [],
  updated_at: '2025-06-01T10:00:00Z',
  runtime_intent: { status: 'stopped' as const, updated_at: '2025-06-01T10:00:00Z', source_command_id: null, reason: null },
  runtime_commands: [],
  runtime_runs: [],
  runtime_activations: [],
};

const mockRuntimeStatePaused = {
  status: 'running' as const,
  project_id: 'project' as const,
  pid: 1234,
  started_at: '2025-06-01T08:00:00Z',
  current_card_id: 'card-001',
  current_agent_session_id: 'session-abc',
  paused: true,
  paused_at: '2025-06-01T10:30:00Z',
  queue: ['card-002'],
  running_processes: ['proc-1'],
  updated_at: '2025-06-01T10:30:00Z',
  runtime_intent: { status: 'running' as const, updated_at: '2025-06-01T10:30:00Z', source_command_id: null, reason: null },
  runtime_commands: [],
  runtime_runs: [],
  runtime_activations: [],
};

const mockRuntimeStateFrozen = {
  status: 'frozen' as const,
  project_id: 'project' as const,
  pid: 1234,
  started_at: '2025-06-01T08:00:00Z',
  current_card_id: null,
  current_agent_session_id: null,
  paused: false,
  paused_at: null,
  queue: [],
  running_processes: [],
  updated_at: '2025-06-01T11:00:00Z',
  frozen_reason: 'API rate limit exceeded',
  runtime_intent: { status: 'running' as const, updated_at: '2025-06-01T11:00:00Z', source_command_id: null, reason: null },
  runtime_commands: [],
  runtime_runs: [],
  runtime_activations: [],
};

const mockCardIndex = {
  total: 42,
  byStatus: { done: 30, failed: 3, blocked: 2, active: 5, backlog: 2 },
  byType: { code: 20, test: 10, plan: 5, goal: 3, doc: 4 },
};

const mockCardStoreHealth = {
  canonical: 'ok' as const,
  compatibilitySnapshots: 'degraded' as const,
  lastCompatibilitySnapshotWarning: {
    code: 'compatibility-snapshot-degraded' as const,
    operation: 'mutation-rebuild' as const,
    relativePath: '.saivage/cards/tree/project.children.json',
    message: 'Synthetic warning with token=[REDACTED]',
    occurredAt: '2026-01-01T00:00:00.000Z',
    canonicalCommitted: true,
  },
  warnings: [],
};


const mockServerAvailability = {
  generatedAt: '2026-01-01T00:00:02.000Z',
  components: {
    api: { state: 'available' as const, source: 'health-check' as const, checkedAt: '2026-01-01T00:00:02.000Z' },
    runtime: { state: 'degraded' as const, source: 'runtime-state' as const, checkedAt: '2026-01-01T00:00:02.000Z' },
    mcp: { state: 'unavailable' as const, source: 'startup' as const, checkedAt: '2026-01-01T00:00:02.000Z', diagnostic: { code: 'mcp-manager-start-failed', summary: 'Error: synthetic redacted startup failure' } },
  },
};

const mockRuntimeStateResponse = {
  runtime: mockRuntimeState,
  cardIndex: mockCardIndex,
};

const mockNullRuntimeResponse = {
  runtime: null,
  cardIndex: { total: 0, byStatus: {}, byType: {} },
};

describe('useRuntimeStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsTypeHandlers.clear();
    reconnectHandlers.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('has empty defaults', () => {
      const store = setupStore();
      expect(store.runtime).toBeNull();
      expect(store.cardIndex).toEqual({ total: 0, byStatus: {}, byType: {} });
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
    });

    it('computed getters return sensible defaults when runtime is null', () => {
      const store = setupStore();
      expect(store.status).toBe('idle');
      expect(store.isRunning).toBe(false);
      expect(store.isPaused).toBe(false);
      expect(store.isFrozen).toBe(false);
      expect(store.currentCardId).toBeNull();
      expect(store.currentAgentSessionId).toBeNull();
      expect('queueLength' in store).toBe(false);
      expect(store.legacyQueueLength).toBe(0);
      expect(store.runningProcessCount).toBe(0);
      expect(store.statusLabel).toBe('unknown');
      expect(store.doneGoals).toBe(0);
      expect(store.failedBlocked).toBe(0);
    });
  });

  describe('fetchState() success', () => {
    it('populates runtime and cardIndex on success', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);

      await store.fetchState();

      expect(store.runtime).toEqual(mockRuntimeState);
      expect(store.cardIndex).toEqual(mockCardIndex);
      expect(store.cardStoreHealth).toBeNull();
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
    });

    it('derives runtime summary records from REST runtime state', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({ runtime: mockRuntimeStateWithSummary, cardIndex: mockCardIndex });

      await store.fetchState();

      expect(store.intent).toEqual(mockIntent);
      expect(store.currentRun).toEqual(mockRootRun);
      expect(store.rootRun).toEqual(mockRootRun);
      expect(store.activeChildRuns).toEqual([mockChildRun]);
      expect(store.activations).toEqual([mockActivation]);
      expect(store.lastCommand).toEqual(mockCommand);
      expect(store.lastActionableError).toBeNull();
    });

    it('correctly sets computed getters after fetch', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);

      await store.fetchState();

      expect(store.status).toBe('running');
      expect(store.isRunning).toBe(true);
      expect(store.isPaused).toBe(false);
      expect(store.isFrozen).toBe(false);
      expect(store.currentCardId).toBe('card-001');
      expect(store.currentAgentSessionId).toBe('session-abc');
      expect(store.legacyQueueLength).toBe(2);
      expect(store.runningProcessCount).toBe(3);
      expect(store.statusLabel).toBe('running');
      expect(store.runtime).toEqual(mockRuntimeState);
      expect(store.doneGoals).toBe(30);
      expect(store.failedBlocked).toBe(5);
    });

    it('handles null runtime in response', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockNullRuntimeResponse);

      await store.fetchState();

      expect(store.runtime).toBeNull();
      expect(store.cardIndex).toEqual({ total: 0, byStatus: {}, byType: {} });
      expect(store.status).toBe('idle');
      expect(store.statusLabel).toBe('unknown');
    });

    it('statusLabel returns "paused" when paused is true regardless of status', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({
        runtime: mockRuntimeStatePaused,
        cardIndex: mockCardIndex,
      });

      await store.fetchState();

      expect(store.status).toBe('running');
      expect(store.isPaused).toBe(true);
      expect(store.statusLabel).toBe('paused');
    });

    it('statusLabel returns "frozen" when status is frozen', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({
        runtime: mockRuntimeStateFrozen,
        cardIndex: mockCardIndex,
      });

      await store.fetchState();

      expect(store.isFrozen).toBe(true);
      expect(store.statusLabel).toBe('frozen');
    });
  });



    it('populates serverAvailability from REST and treats absence as optional', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({ ...mockRuntimeStateResponse, serverAvailability: mockServerAvailability });
      await store.fetchState();
      expect(store.serverAvailability).toEqual(mockServerAvailability);
      expect(store.availabilityDetail).toContain('Runtime is using persisted state fallback');
      expect(store.availabilityDetail).toContain('MCP unavailable');

      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      await store.fetchState();
      expect(store.serverAvailability).toBeNull();
    });

    it('populates CardStore health from REST and treats absence as unknown', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({ ...mockRuntimeStateResponse, cardStoreHealth: mockCardStoreHealth });
      await store.fetchState();
      expect(store.cardStoreHealth).toEqual(mockCardStoreHealth);

      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      await store.fetchState();
      expect(store.cardStoreHealth).toBeNull();
    });

  describe('fetchState() loading/error', () => {
    it('sets loading=true while fetching', async () => {
      const store = setupStore();
      let resolve: (v: typeof mockRuntimeStateResponse) => void;
      const promise = new Promise<typeof mockRuntimeStateResponse>((r) => { resolve = r; });
      vi.mocked(getRuntimeState).mockReturnValue(promise);

      const fetchPromise = store.fetchState();
      expect(store.loading).toBe(true);

      resolve!(mockRuntimeStateResponse);
      await fetchPromise;
      expect(store.loading).toBe(false);
    });

    it('sets unauthorized on 401 failures', async () => {
      const store = setupStore();
      const { ApiError } = await import('../api/client');
      vi.mocked(getRuntimeState).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));

      await expect(store.fetchState()).rejects.toThrow('Unauthorized');
      expect(store.unauthorized).toBe(true);
      expect(store.runtimeDetail).toContain('valid API token');
    });

    it('describes paused runtime with run and activation terminology instead of queued work', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({ ...mockRuntimeStateResponse, runtime: mockRuntimeStatePaused });

      await store.fetchState();

      expect(store.runtimeDetail).toContain('active runs and activation edges');
      expect(store.runtimeDetail.toLowerCase()).not.toContain('queued work');
    });
  });

  describe('startProject()/stopProject()', () => {
    it('calls start_project and records command intent and root run', async () => {
      const store = setupStore();
      vi.mocked(startProject).mockResolvedValue({ success: true, command: mockCommand, intent: mockIntent, run: mockRootRun });

      await store.startProject();

      expect(startProject).toHaveBeenCalledOnce();
      expect(store.intent).toEqual(mockIntent);
      expect(store.lastCommand).toEqual(mockCommand);
      expect(store.currentRun).toEqual(mockRootRun);
      expect(store.commandInFlight).toBeNull();
    });

    it('keeps runtime-facing state coherent after start_project resolves from a stale idle snapshot', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({ runtime: mockRuntimeStateIdle, cardIndex: mockCardIndex });
      await store.fetchState();
      vi.mocked(startProject).mockResolvedValue({ success: true, command: mockCommand, intent: mockIntent, run: mockRootRun });

      await store.startProject();

      expect(store.intent).toEqual(mockIntent);
      expect(store.lastCommand).toEqual(mockCommand);
      expect(store.rootRun).toEqual(mockRootRun);
      expect(store.status).toBe('running');
      expect(store.isRunning).toBe(true);
      expect(store.isPaused).toBe(false);
      expect(store.currentCardId).toBe('project');
      expect(store.currentAgentSessionId).toBe('session-root');
      expect(store.runtimeModeLabel).toBe('Running');
      expect(store.runtime?.runtime_intent).toEqual(mockIntent);
      expect(store.runtime?.runtime_commands).toContainEqual(mockCommand);
      expect(store.runtime?.runtime_runs).toContainEqual(mockRootRun);
    });

    it('keeps runtime-facing state coherent after stop_project resolves from a stale running snapshot', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({ runtime: mockRuntimeStateWithSummary, cardIndex: mockCardIndex });
      await store.fetchState();
      vi.mocked(stopProject).mockResolvedValue({ success: true, command: mockStopCommand, intent: mockStopIntent, run: mockStoppedRootRun });

      await store.stopProject();

      expect(store.intent).toEqual(mockStopIntent);
      expect(store.lastCommand).toEqual(mockStopCommand);
      expect(store.rootRun).toEqual(mockStoppedRootRun);
      expect(store.activeChildRuns).toEqual([]);
      expect(store.status).toBe('idle');
      expect(store.isRunning).toBe(false);
      expect(store.isPaused).toBe(false);
      expect(store.currentCardId).toBeNull();
      expect(store.currentAgentSessionId).toBeNull();
      expect(store.runtimeModeLabel).toBe('Idle');
      expect(store.runtime?.runtime_intent).toEqual(mockStopIntent);
      expect(store.runtime?.runtime_commands).toContainEqual(mockStopCommand);
      expect(store.runtime?.runtime_runs).toContainEqual(mockStoppedRootRun);
    });

    it('calls stop_project and captures actionable error envelopes from API errors', async () => {
      const store = setupStore();
      const { ApiError } = await import('../api/client');
      vi.mocked(stopProject).mockRejectedValue(new ApiError(409, 'Already running', { actionable_error: mockActionableError }));

      await expect(store.stopProject()).rejects.toThrow('Already running');

      expect(stopProject).toHaveBeenCalledOnce();
      expect(store.lastActionableError).toEqual(mockActionableError);
      expect(store.commandInFlight).toBeNull();
    });
  });

  describe('pause()', () => {
    it('uses the RuntimeState returned by pauseRuntime instead of an optimistic patch', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      await store.fetchState();
      vi.mocked(pauseRuntime).mockResolvedValue({ ...mockRuntimeStatePaused, status: 'running', paused: true });

      await store.pause();

      expect(store.runtime).toEqual({ ...mockRuntimeStatePaused, status: 'running', paused: true });
      expect(store.isPaused).toBe(true);
      expect(store.status).toBe('running');
    });
  });

  describe('resume()', () => {
    it('after pause-then-resume, status and statusLabel are consistent', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      await store.fetchState();
      vi.mocked(pauseRuntime).mockResolvedValue({ ...mockRuntimeStatePaused, status: 'running', paused: true });
      await store.pause();
      vi.mocked(resumeRuntime).mockResolvedValue(mockRuntimeState);

      await store.resume();

      expect(store.isPaused).toBe(false);
      expect(store.status).toBe('running');
      expect(store.statusLabel).toBe('running');
      expect(store.runtime).toEqual(mockRuntimeState);
    });
  });

  describe('setupWsListener — WebSocket events', () => {
    it('registers status and reconnect handlers when called', () => {
      const store = setupStore();
      store.setupWsListener();
      expect(wsTypeHandlers.has('status')).toBe(true);
      expect(wsTypeHandlers.has('activity')).toBe(true);
      expect(wsTypeHandlers.has('error')).toBe(true);
      expect(wsTypeHandlers.get('status')?.size).toBe(1);
      expect(wsTypeHandlers.get('activity')?.size).toBe(1);
      expect(wsTypeHandlers.get('error')?.size).toBe(1);
      expect(reconnectHandlers.size).toBe(1);
    });

    it('is idempotent for status and reconnect registration', () => {
      const store = setupStore();
      store.setupWsListener();
      store.setupWsListener();
      expect(wsTypeHandlers.get('status')?.size).toBe(1);
      expect(wsTypeHandlers.get('activity')?.size).toBe(1);
      expect(wsTypeHandlers.get('error')?.size).toBe(1);
      expect(reconnectHandlers.size).toBe(1);
    });

    it('refetches runtime state on reconnect', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      store.setupWsListener();

      fireReconnect();

      await vi.waitFor(() => {
        expect(getRuntimeState).toHaveBeenCalledOnce();
      });
    });

    it('handles runtime-state event and updates runtime + cardIndex', () => {
      const store = setupStore();
      store.setupWsListener();

      fireWsEvent('status', {
        event: 'runtime-state',
        runtime: mockRuntimeState,
        cardIndex: mockCardIndex,
      });

      expect(store.runtime).toEqual(mockRuntimeState);
      expect(store.cardIndex).toEqual(mockCardIndex);
    });

    it('updates runtime summary from runtime-state event when backend includes runtime ledger fields', () => {
      const store = setupStore();
      store.setupWsListener();

      fireWsEvent('status', {
        event: 'runtime-state',
        runtime: mockRuntimeStateWithSummary,
      });

      expect(store.intent).toEqual(mockIntent);
      expect(store.currentRun).toEqual(mockRootRun);
      expect(store.activeChildRuns).toEqual([mockChildRun]);
      expect(store.activations).toEqual([mockActivation]);
      expect(store.lastCommand).toEqual(mockCommand);
    });

    it('consumes command activation run and actionable error WebSocket events', () => {
      const store = setupStore();
      store.setupWsListener();

      fireWsEvent('activity', { event: 'runtime.command', command: mockCommand });
      fireWsEvent('status', { event: 'runtime.run', run: mockRootRun });
      fireWsEvent('activity', { event: 'runtime.activation', activation: mockActivation });
      fireWsEvent('error', { event: 'runtime.actionable_error', actionable_error: mockActionableError });

      expect(store.lastCommand).toEqual(mockCommand);
      expect(store.currentRun).toEqual(mockRootRun);
      expect(store.activations).toEqual([mockActivation]);
      expect(store.lastActionableError).toEqual(mockActionableError);
    });



    it('updates serverAvailability from runtime-state only when the optional field is present', () => {
      const store = setupStore();
      store.setupWsListener();
      fireWsEvent('status', { event: 'runtime-state', serverAvailability: mockServerAvailability });
      expect(store.serverAvailability).toEqual(mockServerAvailability);
      fireWsEvent('status', { event: 'runtime-state', runtime: mockRuntimeState, cardIndex: mockCardIndex });
      expect(store.serverAvailability).toEqual(mockServerAvailability);
    });

    it('updates CardStore health from runtime-state only when the optional field is present', () => {
      const store = setupStore();
      store.setupWsListener();
      fireWsEvent('status', { event: 'runtime-state', cardStoreHealth: mockCardStoreHealth });
      expect(store.cardStoreHealth).toEqual(mockCardStoreHealth);
      fireWsEvent('status', { event: 'runtime-state', runtime: mockRuntimeState, cardIndex: mockCardIndex });
      expect(store.cardStoreHealth).toEqual(mockCardStoreHealth);
    });

    it('handles runtime-paused and runtime-resumed events', () => {
      const store = setupStore();
      store.setupWsListener();

      fireWsEvent('status', {
        event: 'runtime-state',
        runtime: mockRuntimeState,
      });
      fireWsEvent('status', { event: 'runtime-paused' });
      expect(store.isPaused).toBe(true);
      fireWsEvent('status', { event: 'runtime-resumed' });
      expect(store.isPaused).toBe(false);
      expect(store.status).toBe('running');
    });



    it('rejects malformed covered runtime-state WebSocket payloads before mutation', () => {
      const store = setupStore();
      store.setupWsListener();

      expect(() => fireWsEvent('status', {
        event: 'runtime-state',
        runtime: { status: 'paused' },
      })).toThrow();
      expect(store.runtime).toBeNull();
    });

    it('card-status-changed event triggers a fetchState call', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      store.setupWsListener();

      fireWsEvent('status', {
        event: 'card-status-changed',
        card: { id: 'card-001', status: 'done' },
      });

      await vi.waitFor(() => {
        expect(getRuntimeState).toHaveBeenCalledOnce();
      });
    });
  });
});
