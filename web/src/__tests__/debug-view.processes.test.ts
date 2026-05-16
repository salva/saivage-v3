import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import DebugView from '../views/DebugView.vue';
import type { ProcessView } from '../api/types';

vi.mock('../api/client', () => {
  const ApiError = class extends Error {
    status: number;
    body: Record<string, unknown>;
    constructor(status: number, message: string, body: Record<string, unknown> = {}) {
      super(message);
      this.status = status;
      this.body = body;
    }
    get isUnauthorized() { return this.status === 401; }
    get isNotFound() { return this.status === 404; }
  };
  return {
    getDoctor: vi.fn(),
    getDebugSupervision: vi.fn(),
    getDebugState: vi.fn(),
    getDebugErrors: vi.fn(),
    getDebugTimeline: vi.fn(),
    listProcesses: vi.fn(),
    terminateProcess: vi.fn(),
    getMcpTools: vi.fn(),
    listNotes: vi.fn().mockResolvedValue({ notes: [], total: 0 }),
    pauseRuntime: vi.fn().mockResolvedValue({ status: 'paused' }),
    resumeRuntime: vi.fn().mockResolvedValue({ status: 'resumed' }),
    acknowledgeNote: vi.fn().mockResolvedValue({ note: null }),
    deleteNote: vi.fn().mockResolvedValue(undefined),
    clearAllNotes: vi.fn().mockResolvedValue({ deleted: 0, noteIds: [] }),
    ApiError,
  };
});

vi.mock('../stores/ws', () => ({
  useWsStore: () => ({
    onType: vi.fn(() => vi.fn()),
    connectionState: { value: 'offline' },
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    fetchMcpData: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: () => false,
    isConnecting: () => false,
  }),
}));

const mockPush = vi.fn();
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>();
  return {
    ...actual,
    useRouter: () => ({
      push: mockPush,
      currentRoute: { value: { query: {} } },
    }),
  };
});

import {
  listProcesses,
  terminateProcess,
  getDebugState,
  getDebugErrors,
  getDebugTimeline,
  getMcpTools,
  getDoctor,
  getDebugSupervision,
  ApiError,
} from '../api/client';

const mockProcessFull: ProcessView = {
  id: 'proc-full-001',
  card_id: 'card-goal-1',
  command: 'npm test --token sk-[REDACTED] -- --coverage',
  cwd: '.saivage-work/processes/proc-full-001',
  status: 'running',
  started_at: '2025-06-01T10:00:00Z',
  ended_at: null,
  exit_code: null,
  timed_out: false,
  owner: 'agent',
  session_id: 'session-agent-exec-1',
  logs: {
    stdout: '.saivage-work/processes/proc-full-001/stdout.log',
    stderr: '.saivage-work/processes/proc-full-001/stderr.log',
    combined: '.saivage-work/processes/proc-full-001/combined.log',
  },
  control: {
    can_view_logs: true,
    can_terminate: true,
  },
};

const mockProcessMinimal: ProcessView = {
  id: 'proc-min-002',
  card_id: 'card-ops-1',
  command: 'echo "hello"',
  cwd: null,
  status: 'exited',
  started_at: '2025-06-01T10:01:00Z',
  ended_at: '2025-06-01T10:01:01Z',
  exit_code: 0,
  timed_out: false,
  owner: null,
  session_id: null,
  logs: { stdout: null, stderr: null, combined: null },
  control: { can_view_logs: false, can_terminate: false },
};

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/files', name: 'files', component: { template: '<div>Files</div>' } },
    ],
  });
}

function setupDefaultApiMocks(): void {
  vi.mocked(getDebugState).mockResolvedValue({
    runtime: { status: 'running', project_id: 'saivage-v3', pid: 1, started_at: new Date().toISOString(), paused: false, current_card_id: null, current_agent_session_id: null, running_processes: [], queue: [], updated_at: new Date().toISOString() },
    cards: [],
    totalCards: 0,
  });
  vi.mocked(getDebugErrors).mockResolvedValue({ errors: [], total: 0 });
  vi.mocked(getDebugTimeline).mockResolvedValue({ events: [], total: 0 });
  vi.mocked(getMcpTools).mockResolvedValue({ tools: [], servers: [], invocationStats: {}, serverDetails: [] });
  vi.mocked(getDoctor).mockResolvedValue({ status: 'ok', checks: [], issues: [] });
  vi.mocked(getDebugSupervision).mockResolvedValue({ reviews: [], quarantine: [], stats: { total: 0, blocked: 0, passed: 0, sanitized: 0, byRisk: {}, bySourceKind: {} } });
}

async function mountDebugView() {
  setActivePinia(createPinia());
  setupDefaultApiMocks();
  const router = makeRouter();
  const wrapper = mount(DebugView, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return wrapper;
}

async function mountDebugViewWithProcesses(processes: ProcessView[]) {
  vi.mocked(listProcesses).mockResolvedValue({ processes });
  return mountDebugView();
}

async function mountDebugViewWithProcessesError() {
  setActivePinia(createPinia());
  setupDefaultApiMocks();
  vi.mocked(listProcesses).mockRejectedValue(new Error('Backend unavailable'));
  const router = makeRouter();
  const wrapper = mount(DebugView, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return wrapper;
}

async function clickProcessesTab(wrapper: ReturnType<typeof mount>) {
  const tabs = wrapper.findAll('.debug-tab');
  const processesTab = tabs.find((t) => t.text() === 'Processes');
  if (processesTab) {
    await processesTab.trigger('click');
  }
}

describe('DebugView — processes tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    vi.mocked(listProcesses).mockResolvedValue({ processes: [] });
    vi.mocked(terminateProcess).mockResolvedValue({
      terminated: true,
      message: 'Termination requested for proc-full-001. Status is now killed.',
      process: { ...mockProcessFull, status: 'killed', control: { can_view_logs: true, can_terminate: false }, ended_at: '2025-06-01T10:02:00Z' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Processes tab button', async () => {
    const wrapper = await mountDebugView();
    const tabs = wrapper.findAll('.debug-tab');
    const labels = tabs.map((t) => t.text());
    expect(labels).toContain('Processes');
  });

  it('shows "No Saivage-managed processes found." when list is empty', async () => {
    const wrapper = await mountDebugViewWithProcesses([]);
    await clickProcessesTab(wrapper);
    await flushPromises();
    expect(wrapper.find('.debug-empty').text()).toBe('No Saivage-managed processes found.');
  });

  it('renders process cards with safe operator-facing metadata', async () => {
    const wrapper = await mountDebugViewWithProcesses([mockProcessFull]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    const card = wrapper.find('.process-card');
    expect(card.find('.process-id').text()).toBe('proc-full-001');
    expect(card.find('.process-status-badge').text()).toBe('running');
    const text = card.text();
    expect(text).toContain('npm test --token sk-[REDACTED]');
    expect(text).toContain('card-goal-1');
    expect(text).toContain('session-agent-exec-1');
    expect(text).toContain('agent');
    expect(text).toContain('.saivage-work/processes/proc-full-001/combined.log');
    expect(text).not.toContain('PID:');
    expect(text).not.toContain('Group:');
    expect(text).not.toContain('Required:');
  });

  it('renders unavailable safe fields and ended state messaging', async () => {
    const wrapper = await mountDebugViewWithProcesses([mockProcessMinimal]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    const card = wrapper.find('.process-card');
    const text = card.text();
    expect(text).toContain('Unavailable or unsafe to display');
    expect(text).toContain('No safe log references are available for this process.');
    expect(text).toContain('Process has ended; termination is unavailable.');
  });

  it('routes Browse log actions into the Files view with contained path query', async () => {
    const wrapper = await mountDebugViewWithProcesses([mockProcessFull]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    const browseButtons = wrapper.findAll('.process-link-button');
    expect(browseButtons.length).toBeGreaterThan(0);
    await browseButtons[0]!.trigger('click');
    expect(mockPush).toHaveBeenCalledWith({
      name: 'files',
      query: { path: '.saivage-work/processes/proc-full-001/combined.log' },
    });
  });

  it('confirms and submits terminate action for running processes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(listProcesses)
      .mockResolvedValueOnce({ processes: [mockProcessFull] })
      .mockResolvedValueOnce({ processes: [{ ...mockProcessFull, status: 'killed', control: { can_view_logs: true, can_terminate: false }, ended_at: '2025-06-01T10:02:00Z' }] });

    const wrapper = await mountDebugViewWithProcesses([mockProcessFull]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    const terminateButton = wrapper.find('.process-controls .operator-button');
    await terminateButton.trigger('click');
    await flushPromises();

    expect(terminateProcess).toHaveBeenCalledWith('proc-full-001');
    expect(wrapper.text()).toContain('Termination requested for proc-full-001. Status is now killed.');
  });

  it('shows degraded warning when terminate returns 503 and keeps safe process data', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(terminateProcess).mockRejectedValue(new ApiError(503, 'Process is recorded as running, but this server cannot terminate it. Inspect host process state before manual cleanup.', { process: mockProcessFull }));

    const wrapper = await mountDebugViewWithProcesses([mockProcessFull]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    await wrapper.find('.process-controls .operator-button').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('this server cannot terminate it');
    expect(wrapper.text()).toContain('proc-full-001');
  });
});

describe('DebugView — processes tab error state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows explicit error state when listProcesses fetch fails', async () => {
    const wrapper = await mountDebugViewWithProcessesError();
    await clickProcessesTab(wrapper);
    await flushPromises();
    const errorEl = wrapper.find('.debug-error');
    expect(errorEl.exists()).toBe(true);
    expect(errorEl.text()).toContain('Failed to fetch processes');
  });

  it('processes fetch failure does NOT bleed error into State tab', async () => {
    const wrapper = await mountDebugViewWithProcessesError();
    await clickProcessesTab(wrapper);
    await flushPromises();
    const stateTab = wrapper.findAll('.debug-tab').find((t) => t.text() === 'State');
    if (stateTab) {
      await stateTab.trigger('click');
      await flushPromises();
    }
    const stateText = wrapper.find('.debug-tab-content').text();
    expect(stateText).not.toContain('Failed to fetch processes');
    expect(stateText).toContain('Runtime State');
  });
});
