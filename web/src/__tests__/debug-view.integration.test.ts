/**
 * Integration-level regression tests for the DebugView component.
 *
 * These tests go beyond the isolated per-tab tests by verifying:
 *  - Initial mount behaviour: all data panels are in loading/empty state
 *  - Cross-tab switching: navigating between tabs preserves state and
 *    correctly swaps visible panes
 *  - Shared loading/error-state interactions: when one store (debug) is in
 *    error state while another (MCP) is in loading state, both scenarios
 *    render correctly on their respective tabs
 *  - Cross-store interaction: debug store error state does not leak into
 *    the MCP tab and vice versa
 *
 * The API client is fully mocked — no server needed.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import DebugView from '../views/DebugView.vue';
import { useDebugStore } from '../stores/debug';
import { useMcpStore } from '../stores/mcp';

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
  getDebugState,
  getDebugErrors,
  getDebugTimeline,
  listProcesses,
  getMcpTools,
  getDoctor,
  getDebugSupervision,
} from '../api/client';
import type {
  DebugStateResponse,
  DebugErrorsResponse,
  DebugTimelineResponse,
  ProcessListResponse,
  McpToolsResponse,
  DoctorResponse,
  SupervisionResponse,
} from '../api/types';

// ── Fixtures ──────────────────────────────────────────────────

const mockStateResponse: DebugStateResponse = {
  runtime: {
    status: 'running',
    project_id: 'saivage-v3',
    pid: 1234,
    started_at: '2025-06-01T10:00:00Z',
    paused: false,
    current_card_id: 'card-active-1',
    current_agent_session_id: 'session-1',
    running_processes: ['p-1'],
    queue: ['card-pending-1', 'card-pending-2'],
    updated_at: '2025-06-01T10:00:00Z',
  },
  cards: [
    {
      id: 'card-active-1',
      type: 'goal' as const,
      parent: null,
      status: 'active' as const,
      title: 'Active goal card',
      priority: 5,
      depends_on: [],
      blocks: [],
    },
    {
      id: 'card-done-1',
      type: 'ops' as const,
      parent: 'card-active-1',
      status: 'done' as const,
      title: 'Completed task',
      priority: 3,
      depends_on: [],
      blocks: [],
    },
  ],
  totalCards: 2,
};

const mockErrorsResponse: DebugErrorsResponse = {
  errors: [
    {
      source: 'runtime',
      type: 'timeout',
      severity: 'error',
      message: 'Process proc-1 timed out after 30s',
      timestamp: '2025-06-01T10:01:00Z',
    },
    {
      source: 'agent',
      type: 'tool-error',
      severity: 'warning',
      message: 'MCP tool read_file returned empty',
      timestamp: '2025-06-01T10:02:00Z',
    },
  ],
  total: 2,
};

const mockTimelineResponse: DebugTimelineResponse = {
  events: [
    {
      type: 'card_started',
      card_id: 'card-active-1',
      timestamp: '2025-06-01T09:55:00Z',
      data: {},
    },
    {
      type: 'process_launched',
      card_id: 'card-active-1',
      timestamp: '2025-06-01T09:56:00Z',
      data: { command: 'npm test' },
    },
  ],
  total: 2,
};

const mockProcessesResponse: ProcessListResponse = {
  processes: [
    {
      id: 'proc-int-1',
      card_id: 'card-active-1',
      command: 'npm test',
      cwd: '/work/saivage-v3',
      status: 'running',
      pid: 1001,
      started_at: '2025-06-01T10:00:00Z',
      completed_at: null,
      exit_code: null,
      required_for_card_completion: true,
      output_dir: '/work/saivage-v3/.saivage-work/processes/proc-int-1',
      stdout_path: '/work/saivage-v3/.saivage-work/processes/proc-int-1/stdout.log',
      stderr_path: '/work/saivage-v3/.saivage-work/processes/proc-int-1/stderr.log',
      combined_log_path: '/work/saivage-v3/.saivage-work/processes/proc-int-1/combined.log',
      agent_session_id: 'session-1',
      goal_id: 'card-active-1',
      launch_reason: 'Run tests',
      owner_kind: 'agent',
      background_policy: 'foreground',
      process_group_id: null,
    },
  ],
};

const mockMcpResponse: McpToolsResponse = {
  tools: [
    { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
  ],
  servers: ['filesystem'],
  invocationStats: {
    'filesystem:read_file': { total: 10, success: 10, error: 0 },
  },
  serverDetails: [
    {
      name: 'filesystem',
      transport: 'stdio',
      status: 'running',
      toolCount: 1,
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: { type: 'object' as const },
          stats: { total: 10, success: 10, error: 0 },
        },
      ],
    },
  ],
};

const mockDoctorOk: DoctorResponse = {
  status: 'ok',
  checks: [
    { name: 'card-index-check', passed: true },
    { name: 'orphan-check', passed: true },
  ],
  issues: [],
};

const mockSupervisionResponse: SupervisionResponse = {
  reviews: [
    {
      id: 'r-int-1',
      source_kind: 'command_output' as const,
      source_ref: 'proc-int-1/stdout',
      status: 'passed' as const,
      summary: 'Clean output',
      risk: 'low' as const,
      quarantine_id: null,
      created_at: '2025-06-01T10:00:00Z',
    },
  ],
  quarantine: [],
  stats: {
    total: 1,
    blocked: 0,
    passed: 1,
    sanitized: 0,
    byRisk: { low: 1 },
    bySourceKind: { command_output: 1 },
  },
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

// ── Mount helpers ─────────────────────────────────────────────

/**
 * Mount DebugView with ALL mocks pre-resolved to rich data.
 * After mount, the component's onMounted will call fetchAll(),
 * which fetches state/errors/timeline, and also fetchMcpData().
 */
async function mountDebugViewWithAllData() {
  setActivePinia(createPinia());

  // Set up all mock responses BEFORE mount so onMounted fetchAll resolves
  vi.mocked(getDebugState).mockResolvedValue(mockStateResponse);
  vi.mocked(getDebugErrors).mockResolvedValue(mockErrorsResponse);
  vi.mocked(getDebugTimeline).mockResolvedValue(mockTimelineResponse);
  vi.mocked(listProcesses).mockResolvedValue(mockProcessesResponse);
  vi.mocked(getMcpTools).mockResolvedValue(mockMcpResponse);
  vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
  vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervisionResponse);

  const router = makeRouter();
  const wrapper = mount(DebugView, {
    global: {
      plugins: [createPinia(), router],
    },
  });

  // Wait for onMounted side-effects (fetchAll + fetchMcpData) to settle
  await flushPromises();
  return wrapper;
}

/**
 * Mount DebugView with the debug store in an error state, but MCP store loaded.
 * All three debug fetches (state, errors, timeline) are rejected so fetchAll
 * produces the combined "Failed to fetch debug data" error.
 */
async function mountDebugViewWithDebugStoreError() {
  setActivePinia(createPinia());

  // Resolve MCP data so MCP tab works
  vi.mocked(getMcpTools).mockResolvedValue(mockMcpResponse);

  // Reject debug store fetches to simulate backend errors
  const backendErr = new Error('Backend unavailable');
  vi.mocked(getDebugState).mockRejectedValue(backendErr);
  vi.mocked(getDebugErrors).mockRejectedValue(backendErr);
  vi.mocked(getDebugTimeline).mockRejectedValue(backendErr);
  vi.mocked(listProcesses).mockRejectedValue(backendErr);
  vi.mocked(getDoctor).mockRejectedValue(backendErr);
  vi.mocked(getDebugSupervision).mockRejectedValue(backendErr);

  const router = makeRouter();
  const wrapper = mount(DebugView, {
    global: {
      plugins: [createPinia(), router],
    },
  });

  await flushPromises();
  return wrapper;
}

/**
 * Mount DebugView with MCP store in error state, but debug store loaded.
 */
async function mountDebugViewWithMcpStoreError() {
  setActivePinia(createPinia());

  // Resolve debug store data
  vi.mocked(getDebugState).mockResolvedValue(mockStateResponse);
  vi.mocked(getDebugErrors).mockResolvedValue(mockErrorsResponse);
  vi.mocked(getDebugTimeline).mockResolvedValue(mockTimelineResponse);
  vi.mocked(listProcesses).mockResolvedValue(mockProcessesResponse);
  vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
  vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervisionResponse);

  // Reject MCP fetch
  vi.mocked(getMcpTools).mockRejectedValue(new Error('MCP broker down'));

  const router = makeRouter();
  const wrapper = mount(DebugView, {
    global: {
      plugins: [createPinia(), router],
    },
  });

  await flushPromises();
  return wrapper;
}

// ── Helpers ───────────────────────────────────────────────────

/** Find a tab button by label text and return it. */
function findTabButton(wrapper: ReturnType<typeof mount>, label: string) {
  const tabs = wrapper.findAll('.debug-tab');
  return tabs.find((t) => t.text() === label);
}

/** Click a tab button by label and flush promises. */
async function clickTab(wrapper: ReturnType<typeof mount>, label: string) {
  const tab = findTabButton(wrapper, label);
  if (tab) {
    await tab.trigger('click');
    await flushPromises();
  }
}

/** Get the text of the currently visible .debug-tab-content (non-empty). */
function visibleTabContentText(wrapper: ReturnType<typeof mount>): string {
  // All tab content divs are rendered but only one is v-if-true.
  // They're all .debug-tab-content; find the non-empty one.
  const contents = wrapper.findAll('.debug-tab-content');
  for (const c of contents) {
    const text = c.text().trim();
    if (text.length > 0) return text;
  }
  return '';
}

// ── Tests ─────────────────────────────────────────────────────

describe('DebugView — integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Mount / initial load ────────────────────────────────────

  it('mounts and renders all six tab buttons', async () => {
    const wrapper = await mountDebugViewWithAllData();

    const tabs = wrapper.findAll('.debug-tab');
    const labels = tabs.map((t) => t.text());

    expect(labels).toHaveLength(6);
    expect(labels).toContain('State');
    expect(labels).toContain('Errors');
    expect(labels).toContain('Timeline');
    expect(labels).toContain('Processes');
    expect(labels).toContain('Supervision');
    expect(labels).toContain('MCP');
  });

  it('defaults to State tab on mount and shows runtime data', async () => {
    const wrapper = await mountDebugViewWithAllData();

    // State tab should be active by default
    const stateTab = findTabButton(wrapper, 'State');
    expect(stateTab?.classes()).toContain('active');

    // Content should include runtime data
    const contentText = visibleTabContentText(wrapper);
    expect(contentText).toContain('Runtime State');
    expect(contentText).toContain('card-active-1');
    expect(contentText).toContain('Active goal card');
  });

  it('calls fetchAll and fetchMcpData on mount (cross-store initial load)', async () => {
    // Verify that onMounted triggers both debug store and MCP store fetches
    setActivePinia(createPinia());

    const stateSpy = vi.fn().mockResolvedValue(mockStateResponse);
    const errorsSpy = vi.fn().mockResolvedValue(mockErrorsResponse);
    const timelineSpy = vi.fn().mockResolvedValue(mockTimelineResponse);
    const mcpSpy = vi.fn().mockResolvedValue(mockMcpResponse);

    vi.mocked(getDebugState).mockImplementation(stateSpy);
    vi.mocked(getDebugErrors).mockImplementation(errorsSpy);
    vi.mocked(getDebugTimeline).mockImplementation(timelineSpy);
    vi.mocked(getMcpTools).mockImplementation(mcpSpy);
    vi.mocked(listProcesses).mockResolvedValue({ processes: [] });
    vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
    vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervisionResponse);

    const router = makeRouter();
    mount(DebugView, {
      global: {
        plugins: [createPinia(), router],
      },
    });

    await flushPromises();

    // All three debug fetches AND MCP fetch should have been called
    expect(stateSpy).toHaveBeenCalledTimes(1);
    expect(errorsSpy).toHaveBeenCalledTimes(1);
    expect(timelineSpy).toHaveBeenCalledTimes(1);
    expect(mcpSpy).toHaveBeenCalledTimes(1);
  });

  // ── Cross-tab switching ─────────────────────────────────────

  it('switches from State to Errors tab and renders error data', async () => {
    const wrapper = await mountDebugViewWithAllData();

    // Start on State tab
    expect(visibleTabContentText(wrapper)).toContain('Runtime State');

    // Switch to Errors tab
    await clickTab(wrapper, 'Errors');

    const errorsTab = findTabButton(wrapper, 'Errors');
    expect(errorsTab?.classes()).toContain('active');

    const contentText = visibleTabContentText(wrapper);
    expect(contentText).toContain('runtime');
    expect(contentText).toContain('Process proc-1 timed out');
    expect(contentText).toContain('agent');
    expect(contentText).toContain('MCP tool read_file returned empty');
  });

  it('switches from State to Timeline tab and renders sorted events', async () => {
    const wrapper = await mountDebugViewWithAllData();

    await clickTab(wrapper, 'Timeline');

    const timelineTab = findTabButton(wrapper, 'Timeline');
    expect(timelineTab?.classes()).toContain('active');

    const contentText = visibleTabContentText(wrapper);
    expect(contentText).toContain('process_launched');
    expect(contentText).toContain('card_started');
    // Events sorted newest first: process_launched (09:56) before card_started (09:55)
    const processIdx = contentText.indexOf('process_launched');
    const cardIdx = contentText.indexOf('card_started');
    expect(processIdx).toBeLessThan(cardIdx);
  });

  it('switches from State to Processes tab and renders process data', async () => {
    const wrapper = await mountDebugViewWithAllData();

    await clickTab(wrapper, 'Processes');

    const processesTab = findTabButton(wrapper, 'Processes');
    expect(processesTab?.classes()).toContain('active');

    const contentText = visibleTabContentText(wrapper);
    expect(contentText).toContain('proc-int-1');
    expect(contentText).toContain('npm test');
  });

  it('switches from State to MCP tab and renders MCP server data', async () => {
    const wrapper = await mountDebugViewWithAllData();

    await clickTab(wrapper, 'MCP');

    const mcpTab = findTabButton(wrapper, 'MCP');
    expect(mcpTab?.classes()).toContain('active');

    const contentText = visibleTabContentText(wrapper);
    expect(contentText).toContain('Summary');
    expect(contentText).toContain('filesystem');
    expect(contentText).toContain('read_file');
  });

  it('switches from State to Supervision tab and renders doctor data', async () => {
    const wrapper = await mountDebugViewWithAllData();

    await clickTab(wrapper, 'Supervision');

    const supervisionTab = findTabButton(wrapper, 'Supervision');
    expect(supervisionTab?.classes()).toContain('active');

    const contentText = visibleTabContentText(wrapper);
    expect(contentText).toContain('Doctor Diagnostics');
    expect(contentText).toContain('All checks passed');
    expect(contentText).toContain('card-index-check');
  });

  it('performs a full round-trip across all six tabs without errors', async () => {
    const wrapper = await mountDebugViewWithAllData();

    const tabOrder = ['State', 'Errors', 'Timeline', 'Processes', 'Supervision', 'MCP'];
    for (const label of tabOrder) {
      await clickTab(wrapper, label);
      const tab = findTabButton(wrapper, label);
      expect(tab?.classes()).toContain('active');
      // Each tab should have non-empty content
      expect(visibleTabContentText(wrapper).length).toBeGreaterThan(0);
    }
  });

  it('switches away from MCP and back, counting re-fetch on re-visit', async () => {
    // Clear mocks so we can count calls during tab switching
    vi.clearAllMocks();

    const mcpSpy = vi.fn().mockResolvedValue(mockMcpResponse);
    vi.mocked(getMcpTools).mockImplementation(mcpSpy);
    vi.mocked(getDebugState).mockResolvedValue(mockStateResponse);
    vi.mocked(getDebugErrors).mockResolvedValue(mockErrorsResponse);
    vi.mocked(getDebugTimeline).mockResolvedValue(mockTimelineResponse);
    vi.mocked(listProcesses).mockResolvedValue(mockProcessesResponse);
    vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
    vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervisionResponse);

    setActivePinia(createPinia());
    const router = makeRouter();
    const wrapper = mount(DebugView, {
      global: {
        plugins: [createPinia(), router],
      },
    });
    await flushPromises();

    // onMounted calls fetchMcpData → 1 call
    const initialMcpCalls = mcpSpy.mock.calls.length;

    // Switch to MCP tab — setTab('mcp') calls mcpStore.fetchMcpData again
    await clickTab(wrapper, 'MCP');
    // This triggers fetchMcpData via setTab → total should be initial+1
    expect(mcpSpy.mock.calls.length).toBe(initialMcpCalls + 1);

    // Switch away to State
    await clickTab(wrapper, 'State');

    // Switch back to MCP — setTab('mcp') triggers another fetch
    await clickTab(wrapper, 'MCP');
    expect(mcpSpy.mock.calls.length).toBe(initialMcpCalls + 2);

    // Verify MCP data is still rendered
    const contentText = visibleTabContentText(wrapper);
    expect(contentText).toContain('filesystem');
    expect(contentText).toContain('read_file');
  });

  // ── Shared / cross-store loading & error states ─────────────

  it('shows error on State tab when debug store fetch fails, but MCP tab remains functional', async () => {
    const wrapper = await mountDebugViewWithDebugStoreError();

    // By default we're on State tab — fetchAll runs on mount with all 3 fetches
    // failing. The fixed fetchAll collects failures: when all 3 fail it shows
    // the combined "Failed to fetch debug data" message.
    const stateContent = visibleTabContentText(wrapper);
    expect(stateContent).toContain('Failed to fetch debug data');

    // Switch to MCP tab — should work fine since MCP data was loaded
    await clickTab(wrapper, 'MCP');
    const mcpContent = visibleTabContentText(wrapper);
    expect(mcpContent).toContain('filesystem');
    expect(mcpContent).toContain('read_file');
    expect(mcpContent).not.toContain('Failed to fetch');
  });

  it('shows error on MCP tab when MCP fetch fails, but State tab remains functional', async () => {
    const wrapper = await mountDebugViewWithMcpStoreError();

    // State tab should work fine since debug store data was loaded
    const stateContent = visibleTabContentText(wrapper);
    expect(stateContent).toContain('Runtime State');
    expect(stateContent).toContain('card-active-1');

    // Switch to MCP tab — should show error
    await clickTab(wrapper, 'MCP');
    const mcpContent = visibleTabContentText(wrapper);
    expect(mcpContent).toContain('Failed to fetch MCP tools');
    expect(mcpContent).not.toContain('filesystem');
  });

  it('debug store error on State tab does not affect rendering when switching to other tabs', async () => {
    const wrapper = await mountDebugViewWithDebugStoreError();

    // State tab should show the combined error from fetchAll (all 3 failed)
    expect(visibleTabContentText(wrapper)).toContain('Failed to fetch debug data');

    // Errors tab: clicking triggers fetchErrors() individually, which sets
    // error to "Failed to fetch debug errors" (specific to that fetch)
    await clickTab(wrapper, 'Errors');
    expect(visibleTabContentText(wrapper)).toContain('Failed to fetch debug errors');

    // MCP tab should work fine (mcpStore.error is independent)
    await clickTab(wrapper, 'MCP');
    expect(visibleTabContentText(wrapper)).toContain('filesystem');

    // Processes tab: its error is per-fetch (processesError), so the shared
    // debug-store error from State/Errors should NOT bleed into it.
    // However, clicking Processes triggers fetchProcesses() which also rejects
    // in this mount, so it WILL show its own error.
    await clickTab(wrapper, 'Processes');
    const processesText = visibleTabContentText(wrapper);
    expect(processesText).toContain('Failed to fetch processes');
    // But it should NOT contain the State/Errors error messages
    expect(processesText).not.toContain('Failed to fetch debug data');
    expect(processesText).not.toContain('Failed to fetch debug errors');

    // Supervision tab: doctorError and supervisionError are also per-fetch.
    // Click triggers both fetches which reject, so doctor error shows first.
    await clickTab(wrapper, 'Supervision');
    const supervisionText = visibleTabContentText(wrapper);
    // Doctor section error should be the first error rendered
    expect(supervisionText).toContain('Failed to fetch doctor diagnostics');
    // But should NOT contain other pane errors
    expect(supervisionText).not.toContain('Failed to fetch debug data');
    expect(supervisionText).not.toContain('Failed to fetch processes');
  });

  it('tabs maintain independent loading/error state after switching', async () => {
    // State tab shows loaded data, MCP tab shows error — switching
    // between them should show the correct state for each
    const wrapper = await mountDebugViewWithMcpStoreError();

    // State tab: loaded
    await clickTab(wrapper, 'State');
    expect(visibleTabContentText(wrapper)).toContain('Runtime State');

    // MCP tab: error
    await clickTab(wrapper, 'MCP');
    expect(visibleTabContentText(wrapper)).toContain('Failed to fetch MCP tools');

    // Back to State: still loaded
    await clickTab(wrapper, 'State');
    expect(visibleTabContentText(wrapper)).toContain('Runtime State');
    expect(visibleTabContentText(wrapper)).not.toContain('Failed to fetch MCP tools');

    // Back to MCP: still error
    await clickTab(wrapper, 'MCP');
    expect(visibleTabContentText(wrapper)).toContain('Failed to fetch MCP tools');
    expect(visibleTabContentText(wrapper)).not.toContain('Runtime State');

    // Processes tab: should show its own loaded data (not MCP error)
    await clickTab(wrapper, 'Processes');
    const processesText = visibleTabContentText(wrapper);
    expect(processesText).toContain('proc-int-1');
    expect(processesText).not.toContain('Failed to fetch MCP tools');
    expect(processesText).not.toContain('Failed to fetch debug state');

    // Supervision tab: should show doctor data (not MCP error)
    await clickTab(wrapper, 'Supervision');
    const supervisionText = visibleTabContentText(wrapper);
    expect(supervisionText).toContain('Doctor Diagnostics');
    expect(supervisionText).not.toContain('Failed to fetch MCP tools');
  });

  // ── Cross-store: debug store's shared loading ref ────────────

  it('debug store shared loading ref affects State/Errors/Timeline but not MCP tab', async () => {
    // The debug store has a single 'loading' ref that all three (State, Errors,
    // Timeline) tabs use. The MCP tab uses mcpStore.loading independently.
    // Verify these loading states are properly isolated per tab.

    setActivePinia(createPinia());

    // Set up MCP to resolve immediately
    vi.mocked(getMcpTools).mockResolvedValue(mockMcpResponse);

    // Set up debug store fetches to hang so loading stays true
    let resolveState: (v: DebugStateResponse) => void = () => {};
    const statePromise = new Promise<DebugStateResponse>((resolve) => {
      resolveState = resolve;
    });
    vi.mocked(getDebugState).mockReturnValue(statePromise);

    let resolveErrors: (v: DebugErrorsResponse) => void = () => {};
    vi.mocked(getDebugErrors).mockReturnValue(
      new Promise<DebugErrorsResponse>((r) => { resolveErrors = r; }),
    );

    let resolveTimeline: (v: DebugTimelineResponse) => void = () => {};
    vi.mocked(getDebugTimeline).mockReturnValue(
      new Promise<DebugTimelineResponse>((r) => { resolveTimeline = r; }),
    );

    // Other mocks
    vi.mocked(listProcesses).mockResolvedValue(mockProcessesResponse);
    vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
    vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervisionResponse);

    const router = makeRouter();
    const wrapper = mount(DebugView, {
      global: {
        plugins: [createPinia(), router],
      },
    });
    await flushPromises();

    // State tab: should show loading because debug store is loading
    expect(visibleTabContentText(wrapper)).toContain('Loading state...');

    // MCP tab: should show data because MCP resolved independently
    await clickTab(wrapper, 'MCP');
    expect(visibleTabContentText(wrapper)).toContain('filesystem');
    expect(visibleTabContentText(wrapper)).not.toContain('Loading MCP tools...');

    // Now resolve the debug store fetches
    resolveState(mockStateResponse);
    resolveErrors(mockErrorsResponse);
    resolveTimeline(mockTimelineResponse);
    await flushPromises();

    // State tab should now show data
    await clickTab(wrapper, 'State');
    expect(visibleTabContentText(wrapper)).toContain('Runtime State');
  });

  // ── Per-pane error isolation ────────────────────────────────

  it('processesError does not leak into State, Errors, or Timeline panes', async () => {
    // Set up: all debug fetches succeed, but listProcesses fails
    setActivePinia(createPinia());

    vi.mocked(getDebugState).mockResolvedValue(mockStateResponse);
    vi.mocked(getDebugErrors).mockResolvedValue(mockErrorsResponse);
    vi.mocked(getDebugTimeline).mockResolvedValue(mockTimelineResponse);
    vi.mocked(getMcpTools).mockResolvedValue(mockMcpResponse);
    vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
    vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervisionResponse);
    vi.mocked(listProcesses).mockRejectedValue(new Error('Process fetch failed'));

    const router = makeRouter();
    const wrapper = mount(DebugView, {
      global: {
        plugins: [createPinia(), router],
      },
    });
    await flushPromises();

    // State tab: loaded successfully (fetchAll succeeded)
    expect(visibleTabContentText(wrapper)).toContain('Runtime State');
    expect(visibleTabContentText(wrapper)).not.toContain('Process fetch failed');

    // Errors tab: loaded successfully
    await clickTab(wrapper, 'Errors');
    const errorsText = visibleTabContentText(wrapper);
    expect(errorsText).toContain('runtime');
    expect(errorsText).not.toContain('Process fetch failed');

    // Timeline tab: loaded successfully
    await clickTab(wrapper, 'Timeline');
    const timelineText = visibleTabContentText(wrapper);
    expect(timelineText).toContain('process_launched');
    expect(timelineText).not.toContain('Process fetch failed');

    // Processes tab: shows its own error
    await clickTab(wrapper, 'Processes');
    const processesText = visibleTabContentText(wrapper);
    expect(processesText).toContain('Failed to fetch processes');

    // Go back to State — should still be clean
    await clickTab(wrapper, 'State');
    const stateAgain = visibleTabContentText(wrapper);
    expect(stateAgain).toContain('Runtime State');
    expect(stateAgain).not.toContain('Failed to fetch processes');
  });

  it('doctorError does not leak into State or other non-supervision panes', async () => {
    // All fetches succeed except doctor
    setActivePinia(createPinia());

    vi.mocked(getDebugState).mockResolvedValue(mockStateResponse);
    vi.mocked(getDebugErrors).mockResolvedValue(mockErrorsResponse);
    vi.mocked(getDebugTimeline).mockResolvedValue(mockTimelineResponse);
    vi.mocked(getMcpTools).mockResolvedValue(mockMcpResponse);
    vi.mocked(getDoctor).mockRejectedValue(new Error('Doctor failed'));
    vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervisionResponse);
    vi.mocked(listProcesses).mockResolvedValue(mockProcessesResponse);

    const router = makeRouter();
    const wrapper = mount(DebugView, {
      global: {
        plugins: [createPinia(), router],
      },
    });
    await flushPromises();

    // State tab: loaded successfully
    expect(visibleTabContentText(wrapper)).toContain('Runtime State');
    expect(visibleTabContentText(wrapper)).not.toContain('Doctor failed');

    // Processes tab: loaded successfully
    await clickTab(wrapper, 'Processes');
    const processesText = visibleTabContentText(wrapper);
    expect(processesText).toContain('proc-int-1');
    expect(processesText).not.toContain('Doctor failed');

    // Supervision tab: doctor section shows error, supervision section shows data
    await clickTab(wrapper, 'Supervision');
    const supervisionText = visibleTabContentText(wrapper);
    expect(supervisionText).toContain('Failed to fetch doctor diagnostics');
    expect(supervisionText).toContain('Content Supervision');
    // Doctor error should NOT leak into State tab when switching back
    await clickTab(wrapper, 'State');
    expect(visibleTabContentText(wrapper)).toContain('Runtime State');
    expect(visibleTabContentText(wrapper)).not.toContain('Failed to fetch doctor diagnostics');
  });

  // ── Edge cases ──────────────────────────────────────────────

  it('renders timeline tab with no events gracefully', async () => {
    setActivePinia(createPinia());

    vi.mocked(getDebugState).mockResolvedValue(mockStateResponse);
    vi.mocked(getDebugErrors).mockResolvedValue(mockErrorsResponse);
    vi.mocked(getDebugTimeline).mockResolvedValue({ events: [], total: 0 });
    vi.mocked(getMcpTools).mockResolvedValue(mockMcpResponse);
    vi.mocked(listProcesses).mockResolvedValue({ processes: [] });
    vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
    vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervisionResponse);

    const router = makeRouter();
    const wrapper = mount(DebugView, {
      global: {
        plugins: [createPinia(), router],
      },
    });
    await flushPromises();

    await clickTab(wrapper, 'Timeline');
    expect(visibleTabContentText(wrapper)).toContain('No timeline events');
  });

  it('renders errors tab with no errors gracefully', async () => {
    setActivePinia(createPinia());

    vi.mocked(getDebugState).mockResolvedValue(mockStateResponse);
    vi.mocked(getDebugErrors).mockResolvedValue({ errors: [], total: 0 });
    vi.mocked(getDebugTimeline).mockResolvedValue(mockTimelineResponse);
    vi.mocked(getMcpTools).mockResolvedValue(mockMcpResponse);
    vi.mocked(listProcesses).mockResolvedValue({ processes: [] });
    vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
    vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervisionResponse);

    const router = makeRouter();
    const wrapper = mount(DebugView, {
      global: {
        plugins: [createPinia(), router],
      },
    });
    await flushPromises();

    await clickTab(wrapper, 'Errors');
    expect(visibleTabContentText(wrapper)).toContain('No errors recorded');
  });
});
