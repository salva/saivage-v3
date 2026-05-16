/**
 * Bounded component-level regression tests for the DebugView
 * Processes tab behaviour.
 *
 * These tests mount the DebugView component using Vue Test Utils +
 * jsdom and verify that the Processes tab renders expected
 * elements when the debug store contains process data.
 *
 * The API client is fully mocked — no server needed.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import DebugView from '../views/DebugView.vue';
import type { ProcessRecord } from '../api/types';

// ── Mock the API client ───────────────────────────────────────
vi.mock('../api/client', () => {
  const ApiError = class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  };
  return {
    getDoctor: vi.fn(),
    getDebugSupervision: vi.fn(),
    getDebugState: vi.fn(),
    getDebugErrors: vi.fn(),
    getDebugTimeline: vi.fn(),
    listProcesses: vi.fn(),
    getMcpTools: vi.fn(),
    getNotes: vi.fn().mockResolvedValue({ notes: [], total: 0 }),
    pauseRuntime: vi.fn().mockResolvedValue({ status: 'paused' }),
    resumeRuntime: vi.fn().mockResolvedValue({ status: 'resumed' }),
    acknowledgeNote: vi.fn().mockResolvedValue({ note: null }),
    deleteNote: vi.fn().mockResolvedValue(undefined),
    clearNotes: vi.fn().mockResolvedValue({ deleted: 0, noteIds: [] }),
    ApiError,
  };
});

// Mock the WebSocket store — DebugView calls useWsStore
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

// Mock vue-router's useRouter
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
  getDebugState,
  getDebugErrors,
  getDebugTimeline,
  getMcpTools,
  getDoctor,
  getDebugSupervision,
} from '../api/client';

// ── Fixtures ──────────────────────────────────────────────────

/** A process with full ownership/session metadata populated. */
const mockProcessFull: ProcessRecord = {
  id: 'proc-full-001',
  card_id: 'card-goal-1',
  command: 'npm test',
  cwd: '/work/saivage-v3',
  status: 'running',
  pid: 12345,
  started_at: '2025-06-01T10:00:00Z',
  completed_at: null,
  exit_code: null,
  required_for_card_completion: true,
  output_dir: '/work/saivage-v3/.saivage-work/processes/proc-full-001',
  stdout_path: '/work/saivage-v3/.saivage-work/processes/proc-full-001/stdout.log',
  stderr_path: '/work/saivage-v3/.saivage-work/processes/proc-full-001/stderr.log',
  combined_log_path: '/work/saivage-v3/.saivage-work/processes/proc-full-001/combined.log',
  agent_session_id: 'session-agent-exec-1',
  goal_id: 'card-goal-1',
  launch_reason: 'Run tests for goal card',
  owner_kind: 'agent',
  background_policy: 'foreground',
  process_group_id: null,
};

/** A process with minimal metadata (no ownership fields). */
const mockProcessMinimal: ProcessRecord = {
  id: 'proc-min-002',
  card_id: 'card-ops-1',
  command: 'echo "hello"',
  cwd: '/work/saivage-v3',
  status: 'exited',
  pid: null,
  started_at: '2025-06-01T10:01:00Z',
  completed_at: '2025-06-01T10:01:01Z',
  exit_code: 0,
  required_for_card_completion: false,
  output_dir: '/work/saivage-v3/.saivage-work/processes/proc-min-002',
  stdout_path: '/work/saivage-v3/.saivage-work/processes/proc-min-002/stdout.log',
  stderr_path: '/work/saivage-v3/.saivage-work/processes/proc-min-002/stderr.log',
  combined_log_path: '/work/saivage-v3/.saivage-work/processes/proc-min-002/combined.log',
  agent_session_id: null,
  goal_id: null,
  launch_reason: null,
  owner_kind: null,
  background_policy: null,
  process_group_id: null,
};

/** A process with background_policy and process_group_id set. */
const mockProcessDetached: ProcessRecord = {
  id: 'proc-det-003',
  card_id: 'card-test-1',
  command: 'sleep 3600',
  cwd: '/work/saivage-v3',
  status: 'running',
  pid: 54321,
  started_at: '2025-06-01T10:02:00Z',
  completed_at: null,
  exit_code: null,
  required_for_card_completion: false,
  output_dir: '/work/saivage-v3/.saivage-work/processes/proc-det-003',
  stdout_path: '/work/saivage-v3/.saivage-work/processes/proc-det-003/stdout.log',
  stderr_path: '/work/saivage-v3/.saivage-work/processes/proc-det-003/stderr.log',
  combined_log_path: '/work/saivage-v3/.saivage-work/processes/proc-det-003/combined.log',
  agent_session_id: 'session-bg-1',
  goal_id: null,
  launch_reason: 'Background validation',
  owner_kind: 'runtime',
  background_policy: 'detach',
  process_group_id: 42,
};

/** A process with process_group_id = 0 (falsy but valid — must still render Group row). */
const mockProcessGroupIdZero: ProcessRecord = {
  id: 'proc-zero-group',
  card_id: 'card-zero',
  command: 'echo "zero group"',
  cwd: '/work/saivage-v3',
  status: 'running',
  pid: 9999,
  started_at: '2025-06-01T11:00:00Z',
  completed_at: null,
  exit_code: null,
  required_for_card_completion: false,
  output_dir: '/work/saivage-v3/.saivage-work/processes/proc-zero-group',
  stdout_path: '/work/saivage-v3/.saivage-work/processes/proc-zero-group/stdout.log',
  stderr_path: '/work/saivage-v3/.saivage-work/processes/proc-zero-group/stderr.log',
  combined_log_path: '/work/saivage-v3/.saivage-work/processes/proc-zero-group/combined.log',
  agent_session_id: null,
  goal_id: null,
  launch_reason: null,
  owner_kind: null,
  background_policy: null,
  process_group_id: 0,
};

// ── Router factory ────────────────────────────────────────────

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

// ── Mount helper ──────────────────────────────────────────────

async function mountDebugView() {
  setActivePinia(createPinia());
  setupDefaultApiMocks();

  const router = makeRouter();
  const wrapper = mount(DebugView, {
    global: {
      plugins: [createPinia(), router],
    },
  });

  await flushPromises();
  return wrapper;
}

async function mountDebugViewWithProcesses(processes: ProcessRecord[]) {
  vi.mocked(listProcesses).mockResolvedValue({ processes });
  return mountDebugView();
}

async function mountDebugViewWithProcessesError() {
  setActivePinia(createPinia());
  setupDefaultApiMocks();
  vi.mocked(listProcesses).mockRejectedValue(new Error('Backend unavailable'));

  const router = makeRouter();
  const wrapper = mount(DebugView, {
    global: {
      plugins: [createPinia(), router],
    },
  });

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

// ── Tests ─────────────────────────────────────────────────────

describe('DebugView — processes tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    vi.mocked(listProcesses).mockResolvedValue({ processes: [] });
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

  it('shows "No processes found." when list is empty', async () => {
    const wrapper = await mountDebugViewWithProcesses([]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    expect(wrapper.find('.debug-empty').text()).toBe('No processes found.');
  });

  it('renders process cards with key operator-facing metadata', async () => {
    const wrapper = await mountDebugViewWithProcesses([mockProcessFull]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    const cards = wrapper.findAll('.process-card');
    expect(cards).toHaveLength(1);

    const card = cards[0];
    expect(card.find('.process-id').text()).toBe('proc-full-001');
    expect(card.find('.process-status-badge').text()).toBe('running');
    expect(card.find('.process-status-badge').classes()).toContain('ps-running');

    const details = card.findAll('.pd-row');
    const detailTexts = details.map((d) => d.text());

    expect(detailTexts.some((t) => t.includes('npm test'))).toBe(true);
    expect(detailTexts.some((t) => t.includes('card-goal-1'))).toBe(true);
    expect(detailTexts.some((t) => t.includes('12345'))).toBe(true);
    expect(detailTexts.some((t) => t.includes('Yes'))).toBe(true);
  });

  it('renders ownership/session context fields when present', async () => {
    const wrapper = await mountDebugViewWithProcesses([mockProcessFull]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    const card = wrapper.find('.process-card');
    const details = card.findAll('.pd-row');
    const detailTexts = details.map((d) => d.text());

    expect(detailTexts.some((t) => t.includes('Agent Session:') && t.includes('session-agent-exec-1'))).toBe(true);
    expect(detailTexts.some((t) => t.includes('Goal:') && t.includes('card-goal-1'))).toBe(true);
    expect(detailTexts.some((t) => t.includes('Reason:') && t.includes('Run tests for goal card'))).toBe(true);
    expect(detailTexts.some((t) => t.includes('Owner:') && t.includes('agent'))).toBe(true);
    expect(detailTexts.some((t) => t.includes('Policy:') && t.includes('foreground'))).toBe(true);
  });

  it('does NOT render ownership fields when they are null/absent', async () => {
    const wrapper = await mountDebugViewWithProcesses([mockProcessMinimal]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    const card = wrapper.find('.process-card');
    const details = card.findAll('.pd-row');
    const detailTexts = details.map((d) => d.text());

    expect(detailTexts.some((t) => t.includes('echo "hello"'))).toBe(true);
    expect(detailTexts.some((t) => t.includes('card-ops-1'))).toBe(true);
    expect(detailTexts.some((t) => t.includes('No'))).toBe(true);

    expect(detailTexts.some((t) => t.startsWith('Agent Session:'))).toBe(false);
    expect(detailTexts.some((t) => t.startsWith('Goal:'))).toBe(false);
    expect(detailTexts.some((t) => t.startsWith('Reason:'))).toBe(false);
    expect(detailTexts.some((t) => t.startsWith('Owner:'))).toBe(false);
    expect(detailTexts.some((t) => t.startsWith('Policy:'))).toBe(false);
    expect(detailTexts.some((t) => t.startsWith('Group:'))).toBe(false);
  });

  it('renders process_group_id and background_policy when set', async () => {
    const wrapper = await mountDebugViewWithProcesses([mockProcessDetached]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    const card = wrapper.find('.process-card');
    const details = card.findAll('.pd-row');
    const detailTexts = details.map((d) => d.text());

    expect(detailTexts.some((t) => t.includes('Policy:') && t.includes('detach'))).toBe(true);
    expect(detailTexts.some((t) => t.includes('Group:') && t.includes('42'))).toBe(true);
    expect(detailTexts.some((t) => t.includes('Owner:') && t.includes('runtime'))).toBe(true);
  });

  it('renders Group row when process_group_id is 0 (falsy-but-valid metadata)', async () => {
    const wrapper = await mountDebugViewWithProcesses([mockProcessGroupIdZero]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    const card = wrapper.find('.process-card');
    expect(card.exists()).toBe(true);
    expect(card.find('.process-id').text()).toBe('proc-zero-group');

    const details = card.findAll('.pd-row');
    const detailTexts = details.map((d) => d.text());
    expect(detailTexts.some((t) => t.includes('Group:') && t.includes('0'))).toBe(true);
  });

  it('displays multiple process cards when multiple processes exist', async () => {
    const wrapper = await mountDebugViewWithProcesses([mockProcessFull, mockProcessMinimal, mockProcessDetached]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    const cards = wrapper.findAll('.process-card');
    expect(cards).toHaveLength(3);
  });

  it('shows completed_at and exit_code for exited process', async () => {
    const wrapper = await mountDebugViewWithProcesses([mockProcessMinimal]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    const card = wrapper.find('.process-card');
    const details = card.findAll('.pd-row');
    const detailTexts = details.map((d) => d.text());

    expect(detailTexts.some((t) => t.includes('Completed:'))).toBe(true);
    expect(detailTexts.some((t) => t.includes('Exit Code:') && t.includes('0'))).toBe(true);
  });

  it('shows PID as "-" when null', async () => {
    const wrapper = await mountDebugViewWithProcesses([mockProcessMinimal]);
    await clickProcessesTab(wrapper);
    await flushPromises();

    const card = wrapper.find('.process-card');
    const details = card.findAll('.pd-row');
    const detailTexts = details.map((d) => d.text());

    expect(detailTexts.some((t) => t.includes('PID:') && t.includes('-'))).toBe(true);
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

    const emptyEl = wrapper.find('.debug-empty');
    if (emptyEl.exists()) {
      expect(emptyEl.text()).not.toBe('No processes found.');
    }
  });

  it('shows error state instead of empty state when fetch fails then Process tab is revisited', async () => {
    const wrapper = await mountDebugViewWithProcessesError();

    await clickProcessesTab(wrapper);
    await flushPromises();
    expect(wrapper.find('.debug-error').exists()).toBe(true);

    const stateTab = wrapper.findAll('.debug-tab').find((t) => t.text() === 'State');
    if (stateTab) {
      await stateTab.trigger('click');
      await flushPromises();
    }

    await clickProcessesTab(wrapper);
    await flushPromises();
    expect(wrapper.find('.debug-error').exists()).toBe(true);
  });

  it('processes fetch failure does NOT bleed error into State tab', async () => {
    const wrapper = await mountDebugViewWithProcessesError();

    await clickProcessesTab(wrapper);
    await flushPromises();
    expect(wrapper.find('.debug-error').exists()).toBe(true);
    expect(wrapper.find('.debug-error').text()).toContain('Failed to fetch processes');

    const stateTab = wrapper.findAll('.debug-tab').find((t) => t.text() === 'State');
    if (stateTab) {
      await stateTab.trigger('click');
      await flushPromises();
    }

    const stateContent = wrapper.find('.debug-tab-content');
    expect(stateContent.exists()).toBe(true);
    const stateText = stateContent.text();
    expect(stateText).not.toContain('Failed to fetch processes');
    expect(stateText).toContain('Runtime State');
    expect(stateText).toContain('running');
  });

  it('processes fetch failure does NOT bleed error into Errors tab', async () => {
    const wrapper = await mountDebugViewWithProcessesError();

    await clickProcessesTab(wrapper);
    await flushPromises();
    expect(wrapper.find('.debug-error').text()).toContain('Failed to fetch processes');

    const errorsTab = wrapper.findAll('.debug-tab').find((t) => t.text() === 'Errors');
    if (errorsTab) {
      await errorsTab.trigger('click');
      await flushPromises();
    }

    const errorsContent = wrapper.find('.debug-tab-content');
    expect(errorsContent.exists()).toBe(true);
    const errorsText = errorsContent.text();
    expect(errorsText).not.toContain('Failed to fetch processes');
    expect(errorsText).toContain('No errors recorded');
  });

  it('error state on Processes tab does not affect MCP tab', async () => {
    const wrapper = await mountDebugViewWithProcessesError();

    await clickProcessesTab(wrapper);
    await flushPromises();
    expect(wrapper.find('.debug-error').exists()).toBe(true);

    const mcpTab = wrapper.findAll('.debug-tab').find((t) => t.text() === 'MCP');
    if (mcpTab) {
      await mcpTab.trigger('click');
      await flushPromises();
    }

    const mcpContent = wrapper.find('.debug-tab-content');
    expect(mcpContent.exists()).toBe(true);
    const mcpText = mcpContent.text();
    expect(mcpText).not.toContain('Failed to fetch processes');
  });
});
