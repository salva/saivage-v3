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

const liveProcess: ProcessView = {
  id: 'proc-live-001',
  card_id: 'card-goal-1',
  command: 'npm test --token sk-[REDACTED] -- --coverage',
  cwd: '.saivage-work/processes/proc-live-001',
  status: 'running',
  started_at: '2025-06-01T10:00:00Z',
  ended_at: null,
  exit_code: null,
  timed_out: false,
  owner: 'agent',
  session_id: 'session-agent-exec-1',
  logs: {
    stdout: '.saivage-work/processes/proc-live-001/stdout.log',
    stderr: '.saivage-work/processes/proc-live-001/stderr.log',
    combined: '.saivage-work/processes/proc-live-001/combined.log',
  },
  control: {
    can_view_logs: true,
    can_terminate: true,
    terminate_status: 'live-attached',
    terminate_degraded: false,
    terminate_reason: 'Process is running and attached to this server; termination can be requested.',
  },
};

const staleProcess: ProcessView = {
  ...liveProcess,
  id: 'proc-stale-001',
  control: {
    can_view_logs: true,
    can_terminate: false,
    terminate_status: 'stale-not-attached',
    terminate_degraded: true,
    terminate_reason: 'Process is recorded as running, but this server has no live child process attached. Inspect host process state before manual cleanup.',
  },
};

const endedProcess: ProcessView = {
  ...liveProcess,
  id: 'proc-ended-001',
  status: 'exited',
  ended_at: '2025-06-01T10:01:01Z',
  exit_code: 0,
  control: {
    can_view_logs: false,
    can_terminate: false,
    terminate_status: 'already-ended',
    terminate_degraded: false,
    terminate_reason: 'Process has already ended; termination is unavailable.',
  },
  logs: { stdout: null, stderr: null, combined: null },
};

function makeRouter() {
  return createRouter({ history: createWebHistory(), routes: [{ path: '/files', name: 'files', component: { template: '<div>Files</div>' } }] });
}

function setupDefaultApiMocks(): void {
  vi.mocked(getDebugState).mockResolvedValue({ runtime: { status: 'running', project_id: 'saivage-v3', pid: 1, started_at: new Date().toISOString(), paused: false, current_card_id: null, current_agent_session_id: null, running_processes: [], queue: [], updated_at: new Date().toISOString() }, cards: [], totalCards: 0 });
  vi.mocked(getDebugErrors).mockResolvedValue({ errors: [], total: 0 });
  vi.mocked(getDebugTimeline).mockResolvedValue({ events: [], total: 0 });
  vi.mocked(getMcpTools).mockResolvedValue({ tools: [], servers: [], invocationStats: {}, serverDetails: [] });
  vi.mocked(getDoctor).mockResolvedValue({ status: 'ok', checks: [], issues: [] });
  vi.mocked(getDebugSupervision).mockResolvedValue({ reviews: [], quarantine: [], stats: { total: 0, blocked: 0, passed: 0, sanitized: 0, byRisk: {}, bySourceKind: {} } });
}

async function mountDebugViewWithProcesses(processes: ProcessView[]) {
  setActivePinia(createPinia());
  setupDefaultApiMocks();
  vi.mocked(listProcesses).mockResolvedValue({ processes });
  const router = makeRouter();
  const wrapper = mount(DebugView, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return wrapper;
}

async function clickProcessesTab(wrapper: ReturnType<typeof mount>) {
  const tab = wrapper.findAll('.debug-tab').find((t) => t.text() === 'Processes');
  if (tab) await tab.trigger('click');
}

describe('DebugView — processes tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    vi.mocked(listProcesses).mockResolvedValue({ processes: [] });
    vi.mocked(terminateProcess).mockResolvedValue({
      terminated: true,
      message: 'Termination requested for proc-live-001. Status is now killed.',
      process: { ...liveProcess, status: 'killed', ended_at: '2025-06-01T10:02:00Z', control: { ...endedProcess.control } },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows live-attached process control state and terminate button', async () => {
    const wrapper = await mountDebugViewWithProcesses([liveProcess]);
    await clickProcessesTab(wrapper);
    await flushPromises();
    expect(wrapper.text()).toContain('Control: Live-attached');
    expect(wrapper.text()).toContain('termination can be requested');
    expect(wrapper.find('.process-controls .operator-button').exists()).toBe(true);
  });

  it('suppresses normal terminate affordance for stale not-attached running records', async () => {
    const wrapper = await mountDebugViewWithProcesses([staleProcess]);
    await clickProcessesTab(wrapper);
    await flushPromises();
    expect(wrapper.text()).toContain('Control: Degraded — not attached');
    expect(wrapper.text()).toContain('Termination unavailable: this record is marked running, but no live server-owned process is attached.');
    expect(wrapper.find('.process-controls .operator-button').exists()).toBe(false);
  });

  it('shows ended unavailable copy for already-ended process', async () => {
    const wrapper = await mountDebugViewWithProcesses([endedProcess]);
    await clickProcessesTab(wrapper);
    await flushPromises();
    expect(wrapper.text()).toContain('Control: Ended');
    expect(wrapper.text()).toContain('Process has ended; termination is unavailable.');
    expect(wrapper.find('.process-controls .operator-button').exists()).toBe(false);
  });

  it('routes Browse log actions into the Files view with contained path query', async () => {
    const wrapper = await mountDebugViewWithProcesses([liveProcess]);
    await clickProcessesTab(wrapper);
    await flushPromises();
    await wrapper.find('.process-link-button').trigger('click');
    expect(mockPush).toHaveBeenCalledWith({ name: 'files', query: { path: '.saivage-work/processes/proc-live-001/combined.log' } });
  });

  it('confirms and submits terminate action for live-attached processes only', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(listProcesses)
      .mockResolvedValueOnce({ processes: [liveProcess] })
      .mockResolvedValueOnce({ processes: [{ ...endedProcess, id: 'proc-live-001' }] });
    const wrapper = await mountDebugViewWithProcesses([liveProcess]);
    await clickProcessesTab(wrapper);
    await flushPromises();
    await wrapper.find('.process-controls .operator-button').trigger('click');
    await flushPromises();
    expect(terminateProcess).toHaveBeenCalledWith('proc-live-001');
    expect(wrapper.text()).toContain('Termination requested for proc-live-001. Status is now killed.');
  });

  it('shows degraded warning and upserts stale process when terminate returns 503', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(terminateProcess).mockRejectedValue(new ApiError(503, 'server returned 503', { process: staleProcess }));
    const wrapper = await mountDebugViewWithProcesses([liveProcess]);
    await clickProcessesTab(wrapper);
    await flushPromises();
    await wrapper.find('.process-controls .operator-button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('no live child process attached');
    expect(wrapper.text()).toContain('Control: Degraded — not attached');
    const staleCard = wrapper.findAll('.process-card').find((card) => card.text().includes('proc-stale-001'));
    expect(staleCard?.text()).toContain('Termination unavailable: this record is marked running, but no live server-owned process is attached.');
  });
});
