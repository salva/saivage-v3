import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory, type RouteRecordRaw } from 'vue-router';
import { nextTick, ref } from 'vue';
import AppShell from '../components/layout/AppShell.vue';
import DashboardView from '../views/DashboardView.vue';
import CardsView from '../views/CardsView.vue';
import AgentsView from '../views/AgentsView.vue';
import FilesView from '../views/FilesView.vue';
import DebugView from '../views/DebugView.vue';
import NotFound from '../views/NotFound.vue';
import { API_AUTH_REQUIRED_EVENT } from '../utils/auth-events';
import type {
  AgentSession,
  CardDetailResponse,
  CardListResponse,
  DebugErrorsResponse,
  DebugTimelineResponse,
  FileContent,
  FilesListResponse,
  RuntimeState,
  RuntimeStateResponse,
} from '../api/types';

const apiState = vi.hoisted(() => {
  const now = '2026-05-19T12:00:00Z';
  const runtimeRunning = {
    status: 'running',
    project_id: 'synthetic-project',
    pid: 4242,
    started_at: now,
    current_card_id: 'card-smoke',
    current_agent_session_id: 'planner-smoke',
    paused: false,
    paused_at: null,
    queue: [],
    running_processes: ['proc-smoke'],
    updated_at: now,
    runtime_intent: { status: 'running', updated_at: now, source_command_id: 'cmd-smoke' },
    runtime_commands: [{ command_id: 'cmd-smoke', command: 'start_project', status: 'completed', requested_at: now, completed_at: now, source: 'operator' }],
    runtime_runs: [{ run_id: 'run-smoke', kind: 'root', card_id: 'project-smoke', command_id: 'cmd-smoke', phase: 'planner', runtime_status: 'running', session_id: 'planner-smoke', started_at: now, updated_at: now }],
    runtime_activations: [{ activation_id: 'act-smoke', idempotency_key: 'idem-smoke', parent_card_id: 'project-smoke', parent_run_id: 'run-smoke', parent_session_id: 'planner-smoke', parent_tool_call_id: 'tool-smoke', child_card_id: 'card-smoke', status: 'running', requested_at: now, updated_at: now, precondition: 'accepted', runtime_run_id: 'run-child-smoke' }],
  } as RuntimeState;
  const runtimePaused = {
    ...runtimeRunning,
    status: 'paused',
    paused: true,
    paused_at: now,
  } as RuntimeState;
  return {
    now,
    runtimeRunning,
    runtimePaused,
    runtimeResponse: {
      projectRoot: '/work/saivage-v3',
      projectId: 'saivage-v3',
      runtime: runtimeRunning,
      cardIndex: {
        total: 2,
        byStatus: { running: 1, done: 1 },
        byType: { project: 1, code: 1 },
      },
    } as RuntimeStateResponse,
    sessions: [
      {
        id: 'analyst-smoke',
        role: 'analyst',
        status: 'active',
        started_at: now,
        completed_at: null,
        model: 'synthetic-model',
      },
      {
        id: 'planner-smoke',
        role: 'planner',
        status: 'inactive',
        goal_card_id: 'project-smoke',
        card_id: 'card-smoke',
        started_at: now,
        completed_at: null,
        model: 'synthetic-model',
      },
      {
        id: 'reviewer-smoke',
        role: 'reviewer',
        status: 'inactive',
        goal_card_id: 'project-smoke',
        card_id: 'card-smoke',
        started_at: now,
        completed_at: now,
        model: 'synthetic-model',
      },
      {
        id: 'executor-smoke',
        role: 'executor',
        status: 'inactive',
        goal_card_id: 'project-smoke',
        card_id: 'card-smoke',
        started_at: now,
        completed_at: now,
        model: 'synthetic-model',
      },
    ] as AgentSession[],
  };
});

vi.mock('../api/auth', () => ({
  getAuthToken: vi.fn(() => 'synthetic-dashboard-token'),
  setAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
}));

const wsHandlers = vi.hoisted(() => ({
  typeHandlers: new Map<string, Set<(envelope: unknown) => void>>(),
  reconnectHandlers: new Set<() => void>(),
}));

vi.mock('../stores/ws', () => ({
  useWsStore: () => ({
    connectionState: ref('connected'),
    stale: ref(false),
    sessionId: 'synthetic-ws-session',
    reconnectAttempts: 0,
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: () => true,
    isConnecting: () => false,
    onType: (type: string, handler: (envelope: unknown) => void) => {
      let handlers = wsHandlers.typeHandlers.get(type);
      if (!handlers) {
        handlers = new Set();
        wsHandlers.typeHandlers.set(type, handlers);
      }
      handlers.add(handler);
      return () => handlers?.delete(handler);
    },
    onReconnect: (handler: () => void) => {
      wsHandlers.reconnectHandlers.add(handler);
      return () => wsHandlers.reconnectHandlers.delete(handler);
    },
  }),
}));

vi.mock('../api/client', () => {
  class ApiError extends Error {
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
  }

  const card = {
    id: 'card-smoke',
    type: 'code',
    parent: 'project-smoke',
    depth: 1,
    title: 'Synthetic dashboard smoke card',
    description: 'Exercise operator dashboard surfaces without provider calls.',
    status: 'done',
    tags: ['smoke'],
    priority: 90,
    urgency: 'normal',
    created_by: 'user',
    created_at: apiState.now,
    updated_at: apiState.now,
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: 'Synthetic acceptance only.',
    artifacts: [],
    attachments: [],
    retries: 0,
    result: { summary: 'synthetic result', checks: ['docs:verify', 'typecheck'] },
    version_seq: 3,
  } as any;
  const projectCard = {
    ...card,
    id: 'project-smoke',
    type: 'project',
    parent: null,
    depth: 0,
    title: 'Synthetic Project',
    priority: 50,
    status: 'running',
    result: null,
  } as any;
  const cardDetail: CardDetailResponse = {
    card,
    children: [],
    ancestorIds: ['project-smoke'],
    evidence: {
      generatedFiles: [
        {
          path: 'reports/smoke-result.json',
          source: 'result.generated_files',
          exists: true,
          previewable: true,
          blocked: false,
          sensitivity: 'normal',
        },
      ],
      verificationCommands: [
        { command: 'npm run synthetic-smoke', process_id: 'proc-smoke', status: 'completed', exit_code: 0, timed_out: false },
      ],
      artifactPaths: ['reports/smoke-result.json'],
      toolErrors: [],
      summary: {
        state: 'present',
        summary: 'Synthetic evidence is present.',
        hasRecordedEvidence: true,
        hasDurableEvidence: true,
        missingCount: 0,
        blockedCount: 0,
        redactedCount: 0,
        fileCount: 1,
        verificationCount: 1,
        toolErrorCount: 0,
        parseRecovered: false,
      },
    },
    lifecycle: {
      status: 'done',
      terminal: true,
      phase: 'completed',
      explanation: 'Synthetic card completed.',
      completionState: 'marked-done',
      error: null,
      startedAt: apiState.now,
      completedAt: apiState.now,
      durationMs: 1000,
      retries: 0,
      childCounts: { drafting: 0, backlog: 0, active: 0, running: 0, blocked: 0, changed: 0, done: 0, failed: 0, cancelled: 0, needs_verification: 0 },
      hasActiveChildren: false,
      hasBlockingChildren: false,
      dependencyIds: [],
      blockedByDependencyIds: [],
    },
    review: { status: 'passed', review: null, evidenceStatus: 'recorded', summary: 'Synthetic review passed.' },
    planning: { status: 'done', summary: 'Synthetic planning done.', blockedReason: null, createdCardIds: [], updatedCardIds: [], reviewSummary: null, hasUnfinishedChildWork: false, plannerDeclaredDone: true },
    dispatches: { outgoing: [], incoming: [] },
  };
  const cardList: CardListResponse = { cards: [projectCard, card], total: 2 };
  const rootFiles: FilesListResponse = {
    path: '.saivage',
    files: [
      { name: 'runtime', path: '.saivage/runtime', type: 'directory', modifiedAt: apiState.now },
      { name: 'plan.json', path: '.saivage/plan.json', type: 'file', size: 32, modifiedAt: apiState.now },
    ],
  };
  const runtimeFiles: FilesListResponse = {
    path: '.saivage/runtime',
    files: [{ name: 'events.jsonl', path: '.saivage/runtime/events.jsonl', type: 'file', size: 128, modifiedAt: apiState.now }],
  };
  const outputFiles: FilesListResponse = {
    path: '.saivage-work',
    files: [{ name: 'smoke-result.json', path: '.saivage-work/smoke-result.json', type: 'file', size: 64, modifiedAt: apiState.now }],
  };
  const fileContent: FileContent = {
    path: '.saivage/plan.json',
    size: 32,
    contentType: 'application/json',
    content: JSON.stringify({ project: 'synthetic-project', stage: 'operator-dashboard-smoke' }),
  };
  const debugErrors: DebugErrorsResponse = {
    errors: [
      { source: 'planner-smoke', type: 'invocation_failed', severity: 'error', message: 'Synthetic provider failure redacted', timestamp: apiState.now },
    ],
    total: 1,
  };
  const debugTimeline: DebugTimelineResponse = {
    events: [
      { id: 'evt-1', kind: 'model_selected', session_id: 'planner-smoke', timestamp: apiState.now, model: 'synthetic-model' },
      { id: 'evt-2', kind: 'invocation_failed', session_id: 'planner-smoke', timestamp: apiState.now, error_message: 'Synthetic provider failure redacted' },
      { id: 'evt-3', kind: 'card_status_changed', card_id: 'card-smoke', timestamp: apiState.now, status: 'done' },
    ],
    total: 3,
  };

  return {
    ApiError,
    getRuntimeState: vi.fn(async () => apiState.runtimeResponse),
    pauseRuntime: vi.fn(async () => ({ ...apiState.runtimePaused })),
    resumeRuntime: vi.fn(async () => ({ ...apiState.runtimeRunning })),
    startProject: vi.fn(async () => ({ success: true, command: { command_id: 'cmd-smoke-start', command: 'start_project', status: 'completed', requested_at: apiState.now, completed_at: apiState.now, source: 'operator' }, intent: { status: 'running', updated_at: apiState.now, source_command_id: 'cmd-smoke-start' } })),
    stopProject: vi.fn(async () => ({ success: true, command: { command_id: 'cmd-smoke-stop', command: 'stop_project', status: 'completed', requested_at: apiState.now, completed_at: apiState.now, source: 'operator' }, intent: { status: 'stopped', updated_at: apiState.now, source_command_id: 'cmd-smoke-stop' } })),
    listCards: vi.fn(async () => cardList),
    getCard: vi.fn(async () => cardDetail),
    createCard: vi.fn(),
    updateCard: vi.fn(),
    deleteCard: vi.fn(),
    listCardHistory: vi.fn(async () => ({ history: [], total: 0 })),
    getCardHistoryEntry: vi.fn(async () => ({ entry: { ...card, snapshot: card } })),
    getCardDiff: vi.fn(async () => ({ diff: [], from: 1, to: 3, card_id: 'card-smoke' })),
    listAgentSessions: vi.fn(async () => ({ sessions: apiState.sessions })),
    getAgentConversation: vi.fn(async (sessionId: string) => ({
      session: apiState.sessions.find((session) => session.id === sessionId) ?? apiState.sessions[0],
      messages: [
        { id: 'msg-1', session_id: sessionId, role: 'assistant', kind: 'text', content: 'Synthetic agent transcript.', timestamp: apiState.now },
      ],
    })),
    listFiles: vi.fn(async (path?: string) => {
      if (path === '.saivage/runtime') return runtimeFiles;
      if (path === '.saivage-work') return outputFiles;
      return rootFiles;
    }),
    getFileContent: vi.fn(async () => fileContent),
    getDebugState: vi.fn(async () => ({ runtime: apiState.runtimeRunning, cards: [], totalCards: 0 })),
    getDebugErrors: vi.fn(async () => debugErrors),
    getDebugTimeline: vi.fn(async () => debugTimeline),
    getDoctor: vi.fn(async () => ({ status: 'ok', checks: [], issues: [] })),
    getDebugSupervision: vi.fn(async () => ({ reviews: [], quarantine: [], stats: { total: 0, blocked: 0, passed: 0, sanitized: 0, byRisk: {}, bySourceKind: {} } })),
    getMcpTools: vi.fn(async () => ({ tools: [], servers: [], invocationStats: {}, serverDetails: [] })),
    listProcesses: vi.fn(async () => ({ processes: [] })),
    getProcess: vi.fn(),
    terminateProcess: vi.fn(),
    listNotifications: vi.fn(async () => ({ notifications: [], total: 0 })),
    acknowledgeNotification: vi.fn(),
    listControlActions: vi.fn(async () => ({ control_actions: [], total: 0 })),
    listChatSessions: vi.fn(async () => ({ sessions: [] })),
    getChatMessages: vi.fn(async (sessionId: string) => ({
      sessionId,
      messages: [
        { id: `chat-${sessionId}-1`, session_id: sessionId, role: 'assistant', kind: 'text', content: 'Synthetic agent transcript.', timestamp: apiState.now },
      ],
    })),
    sendChatMessage: vi.fn(),
  };
});

function makeRouter() {
  const routes: RouteRecordRaw[] = [
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', name: 'dashboard', component: DashboardView },
    { path: '/cards', name: 'cards', component: CardsView },
    { path: '/cards/:id', name: 'card-detail', component: CardsView },
    { path: '/agents', name: 'agents', component: AgentsView },
    { path: '/agents/:id', name: 'agent-detail', component: AgentsView },
    { path: '/files', name: 'files', component: FilesView },
    { path: '/debug', name: 'debug', component: DebugView },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFound },
  ];
  return createRouter({ history: createMemoryHistory(), routes });
}

async function settle() {
  await flushPromises();
  await nextTick();
  await flushPromises();
}

async function waitForTransition() {
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  await settle();
}

describe('operator dashboard synthetic smoke guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsHandlers.typeHandlers.clear();
    wsHandlers.reconnectHandlers.clear();
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    apiState.runtimeResponse = {
      projectRoot: '/work/saivage-v3',
      projectId: 'saivage-v3',
      runtime: apiState.runtimeRunning,
      cardIndex: { total: 2, byStatus: { running: 1, done: 1 }, byType: { project: 1, code: 1 } },
    };
  });

  it('walks core remediated operator surfaces with synthetic data', async () => {
    const router = makeRouter();
    await router.push('/dashboard');
    await router.isReady();
    const wrapper = mount(AppShell, {
      attachTo: document.body,
      global: { plugins: [createPinia(), router] },
    });
    await settle();

    const { stopProject } = await import('../api/client');
    expect(wrapper.text()).toContain('Runtime Console');
    expect(wrapper.text()).toContain('Activation Edges');
    expect(wrapper.get('.stop-project').text()).toContain('Stop Project');
    vi.mocked(stopProject).mockClear();
    await wrapper.get('.stop-project').trigger('click');
    await settle();
    expect(stopProject).toHaveBeenCalledTimes(1);

    expect(wrapper.find('.pause-chip').exists()).toBe(false);
    expect(wrapper.get('.runtime-chip').attributes('title')).toContain('Dashboard → Runtime Console');
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('Pause');
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('Resume');

    window.dispatchEvent(new CustomEvent(API_AUTH_REQUIRED_EVENT, { detail: { status: 401, path: '/api/state' } }));
    await settle();
    expect(wrapper.find('.auth-required-banner').text()).toContain('API token required');
    await wrapper.get('.auth-banner-action').trigger('click');
    await settle();
    expect(wrapper.find('.token-overlay').exists()).toBe(true);
    await wrapper.get('.token-btn-cancel').trigger('click');
    await waitForTransition();
    expect(wrapper.find('.token-overlay').exists()).toBe(false);

    await wrapper.get('.analyst-chip').trigger('click');
    await settle();
    const analystPanel = wrapper.get('#analyst-chat-panel');
    expect(analystPanel.classes()).toContain('open');
    const sessionPicker = wrapper.get<HTMLSelectElement>('.session-picker');
    const optionGroups = sessionPicker.findAll('optgroup');
    expect(optionGroups.map((group) => group.attributes('label'))).toEqual(['Analyst', 'Planner', 'Reviewer', 'Executor']);
    expect(sessionPicker.text()).toContain('analyst-smoke');
    expect(sessionPicker.text()).toContain('planner-smoke');
    expect(sessionPicker.text()).toContain('reviewer-smoke');
    expect(sessionPicker.text()).toContain('executor-smoke');
    expect(sessionPicker.element.value).toBe('analyst-smoke');
    expect(wrapper.get<HTMLTextAreaElement>('.composer-input').element.disabled).toBe(false);
    await sessionPicker.setValue('planner-smoke');
    await settle();
    expect(wrapper.get<HTMLSelectElement>('.session-picker').element.value).toBe('planner-smoke');
    expect(wrapper.text()).toContain('Synthetic agent transcript.');
    const readOnlyComposer = wrapper.get<HTMLTextAreaElement>('.composer-input');
    expect(readOnlyComposer.element.disabled).toBe(true);
    expect(readOnlyComposer.attributes('title')).toBe('Read-only — switch to analyst to send messages');
    await wrapper.get<HTMLSelectElement>('.session-picker').setValue('analyst-smoke');
    await settle();
    expect(wrapper.get<HTMLSelectElement>('.session-picker').element.value).toBe('analyst-smoke');
    expect(wrapper.get<HTMLTextAreaElement>('.composer-input').element.disabled).toBe(false);

    await router.push('/agents');
    await waitForTransition();
    expect(wrapper.text()).toContain('analyst');
    expect(wrapper.text()).toContain('planner');
    expect(wrapper.text()).toContain('reviewer');
    await wrapper.find('.session-card').trigger('click');
    await settle();
    expect(wrapper.find('.detail-header-bar').text()).toContain('analyst-smoke');
    expect(wrapper.text()).toContain('Synthetic agent transcript.');

    await router.push('/debug');
    await waitForTransition();
    await wrapper.findAll('.debug-tab').find((tab) => tab.text() === 'Timeline')!.trigger('click');
    await settle();
    expect(wrapper.text()).toContain('model_selected');
    expect(wrapper.text()).toContain('invocation_failed');
    expect(wrapper.text()).toContain('card_status_changed');
    await wrapper.findAll('.debug-tab').find((tab) => tab.text() === 'Errors')!.trigger('click');
    await settle();
    expect(wrapper.text()).toContain('planner-smoke (');
    expect(wrapper.text()).toContain('Synthetic provider failure redacted');

    await router.push('/files');
    await waitForTransition();
    await wrapper.findAll('.file-list')[0].findAll('.file-entry')[1].trigger('click');
    await settle();
    expect(wrapper.find('.code-block').text()).toContain('operator-dashboard-smoke');
    await wrapper.findAll('.file-list')[0].findAll('.file-entry')[0].trigger('click');
    await settle();
    expect(wrapper.find('.file-viewer').exists()).toBe(false);
    expect(wrapper.text()).toContain('events.jsonl');

    await router.push('/cards/card-smoke');
    await waitForTransition();
    expect(wrapper.text()).toContain('Synthetic dashboard smoke card');
    expect(wrapper.text()).toContain('Priority');
    expect(wrapper.text()).toContain('90');
    expect(wrapper.text()).not.toContain('/ 10');
    expect(wrapper.text()).toContain('Files: 1');
    expect(wrapper.text()).toContain('Checks: 1');
    expect(wrapper.text()).toContain('Tool errors: 0');
    const resultCode = wrapper.find('section.detail-section .code-block');
    expect(resultCode.exists()).toBe(true);
    expect(resultCode.text()).toContain('"summary": "synthetic result"');

    wrapper.unmount();
  });
});
