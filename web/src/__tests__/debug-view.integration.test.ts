/**
 * Integration-level regression tests for the DebugView component.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import DebugView from '../views/DebugView.vue';

vi.mock('../api/client', () => {
  const ApiError = class extends Error {
    status: number;
    body: Record<string, unknown>;
    constructor(status: number, message: string, body: Record<string, unknown> = {}) {
      super(message);
      this.status = status;
      this.body = body;
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
    listNotes: vi.fn(),
    acknowledgeNote: vi.fn(),
    deleteNote: vi.fn(),
    clearAllNotes: vi.fn(),
    pauseRuntime: vi.fn(),
    resumeRuntime: vi.fn(),
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
  getDebugState,
  getDebugErrors,
  getDebugTimeline,
  listProcesses,
  getMcpTools,
  getDoctor,
  getDebugSupervision,
  listNotes,
  acknowledgeNote,
  deleteNote,
  clearAllNotes,
  pauseRuntime,
  resumeRuntime,
  ApiError,
} from '../api/client';
import type {
  DebugStateResponse,
  DebugErrorsResponse,
  DebugTimelineResponse,
  ProcessListResponse,
  McpToolsResponse,
  DoctorResponse,
  SupervisionResponse,
  NotesListResponse,
} from '../api/types';

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
  ],
  totalCards: 1,
};

const mockFrozenStateResponse: DebugStateResponse = {
  ...mockStateResponse,
  runtime: {
    ...mockStateResponse.runtime!,
    status: 'frozen',
    paused: true,
    frozen_reason: 'operator handoff',
  },
};

const mockUnavailableStateResponse: DebugStateResponse = {
  ...mockStateResponse,
  runtime: null,
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
  ],
  total: 1,
};

const mockTimelineResponse: DebugTimelineResponse = {
  events: [
    {
      id: 'evt-process-launched',
      kind: 'process_launched',
      card_id: 'card-active-1',
      timestamp: '2025-06-01T09:56:00Z',
      command: 'npm test',
    },
  ],
  total: 1,
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
  ],
  issues: [],
};

const mockSupervisionResponse: SupervisionResponse = {
  reviews: [],
  quarantine: [],
  stats: {
    total: 0,
    blocked: 0,
    passed: 0,
    sanitized: 0,
    byRisk: {},
    bySourceKind: {},
  },
};

const mockNotesResponse: NotesListResponse = {
  notes: [
    {
      card_id: 'card-active-1',
      note_id: 'note-1',
      timestamp: '2025-06-01T10:03:00Z',
      kind: 'directive',
      note: {
        id: 'note-1',
        card_id: 'card-active-1',
        author: 'planner',
        timestamp: '2025-06-01T10:03:00Z',
        content: 'Check runtime status before proceeding.',
        kind: 'directive',
        handled: false,
      },
    },
  ],
  total: 1,
};

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/files', name: 'files', component: { template: '<div>Files</div>' } },
    ],
  });
}

function setupCommonMocks(): void {
  vi.mocked(getDebugState).mockResolvedValue(mockStateResponse);
  vi.mocked(getDebugErrors).mockResolvedValue(mockErrorsResponse);
  vi.mocked(getDebugTimeline).mockResolvedValue(mockTimelineResponse);
  vi.mocked(listProcesses).mockResolvedValue(mockProcessesResponse);
  vi.mocked(getMcpTools).mockResolvedValue(mockMcpResponse);
  vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
  vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervisionResponse);
  vi.mocked(listNotes).mockResolvedValue(mockNotesResponse);
  vi.mocked(acknowledgeNote).mockResolvedValue({ note: { ...mockNotesResponse.notes[0].note!, handled: true, handled_at: '2025-06-01T10:04:00Z' } });
  vi.mocked(deleteNote).mockResolvedValue(undefined);
  vi.mocked(clearAllNotes).mockResolvedValue({ deleted: 1, noteIds: ['note-1'] });
  vi.mocked(pauseRuntime).mockResolvedValue({ status: 'paused' });
  vi.mocked(resumeRuntime).mockResolvedValue({ status: 'resumed' });
}

async function mountDebugView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = makeRouter();
  const wrapper = mount(DebugView, {
    global: {
      plugins: [pinia, router],
    },
  });
  await flushPromises();
  return wrapper;
}

function findTabButton(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper.findAll('.debug-tab').find((t) => t.text() === label);
}

async function clickTab(wrapper: ReturnType<typeof mount>, label: string) {
  const tab = findTabButton(wrapper, label);
  if (!tab) throw new Error(`Tab not found: ${label}`);
  await tab.trigger('click');
  await flushPromises();
}

describe('DebugView — integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    setupCommonMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders operator control tab and fetches operator APIs on open', async () => {
    const wrapper = await mountDebugView();
    expect(wrapper.findAll('.debug-tab').map((t) => t.text())).toContain('Operator Control');

    await clickTab(wrapper, 'Operator Control');

    expect(listNotes).toHaveBeenCalled();
    expect(getDebugState).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Runtime Controls');
    expect(wrapper.text()).toContain('Operator Notes (1)');
    expect(wrapper.text()).toContain('Check runtime status before proceeding.');
  });

  it('shows loading operator copy while notes request is pending', async () => {
    let resolveNotes: (value: NotesListResponse) => void = () => {};
    vi.mocked(listNotes).mockReturnValue(new Promise((resolve) => { resolveNotes = resolve; }));

    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');

    expect(wrapper.text()).toContain('Loading operator notes...');

    resolveNotes(mockNotesResponse);
    await flushPromises();
  });

  it('shows empty notes state', async () => {
    vi.mocked(listNotes).mockResolvedValue({ notes: [], total: 0 });
    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');
    expect(wrapper.text()).toContain('No unhandled operator notes.');
  });

  it('acknowledges a note and shows success feedback', async () => {
    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');

    const button = wrapper.find('[aria-label="Acknowledge note note-1"]');
    await button.trigger('click');
    await flushPromises();

    expect(acknowledgeNote).toHaveBeenCalledWith('note-1');
    expect(wrapper.text()).toContain('Note acknowledged.');
    expect(wrapper.text()).toContain('No unhandled operator notes.');
  });

  it('deletes a note and shows success feedback', async () => {
    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');

    const button = wrapper.find('[aria-label="Delete note note-1"]');
    await button.trigger('click');
    await flushPromises();

    expect(deleteNote).toHaveBeenCalledWith('note-1');
    expect(wrapper.text()).toContain('Note deleted.');
    expect(wrapper.text()).toContain('No unhandled operator notes.');
  });

  it('clears notes and shows count success feedback', async () => {
    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');

    const clearButton = wrapper.findAll('button').find((b) => b.text() === 'Clear all');
    await clearButton!.trigger('click');
    await flushPromises();

    expect(clearAllNotes).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Cleared 1 unhandled notes.');
    expect(wrapper.text()).toContain('No unhandled operator notes.');
  });

  it('pauses runtime and shows success feedback', async () => {
    vi.mocked(getDebugState)
      .mockResolvedValueOnce(mockStateResponse)
      .mockResolvedValueOnce(mockStateResponse)
      .mockResolvedValueOnce({ ...mockStateResponse, runtime: { ...mockStateResponse.runtime!, status: 'paused', paused: true } });

    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');

    const pauseButton = wrapper.findAll('button').find((b) => b.text() === 'Pause runtime');
    await pauseButton!.trigger('click');
    await flushPromises();

    expect(pauseRuntime).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Runtime pause requested successfully.');
  });

  it('resumes runtime and shows success feedback', async () => {
    vi.mocked(getDebugState)
      .mockResolvedValueOnce({ ...mockStateResponse, runtime: { ...mockStateResponse.runtime!, status: 'paused', paused: true } })
      .mockResolvedValueOnce({ ...mockStateResponse, runtime: { ...mockStateResponse.runtime!, status: 'paused', paused: true } })
      .mockResolvedValueOnce(mockStateResponse);

    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');

    const resumeButton = wrapper.findAll('button').find((b) => b.text() === 'Resume runtime');
    await resumeButton!.trigger('click');
    await flushPromises();

    expect(resumeRuntime).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Runtime resume requested successfully.');
  });

  it('disables generic resume and shows frozen guidance for frozen runtime', async () => {
    vi.mocked(getDebugState).mockResolvedValue(mockFrozenStateResponse);

    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');

    const resumeButton = wrapper.findAll('button').find((b) => b.text() === 'Resume runtime');
    expect(resumeButton!.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('Frozen runtime cannot be resumed here. Use resume-from-freeze.');
  });

  it('shows frozen resume rejection copy when resume API rejects with resume-from-freeze action', async () => {
    vi.mocked(getDebugState)
      .mockResolvedValueOnce({ ...mockStateResponse, runtime: { ...mockStateResponse.runtime!, status: 'paused', paused: true } })
      .mockResolvedValueOnce({ ...mockStateResponse, runtime: { ...mockStateResponse.runtime!, status: 'paused', paused: true } })
      .mockResolvedValueOnce(mockFrozenStateResponse);
    vi.mocked(resumeRuntime).mockRejectedValue(new ApiError(400, 'Runtime is frozen', { action: 'resume-from-freeze' }));

    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');

    const resumeButton = wrapper.findAll('button').find((b) => b.text() === 'Resume runtime');
    await resumeButton!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Runtime is frozen. Generic resume is blocked. Use the resume-from-freeze workflow to restore from the freeze manifest before resuming dispatch.');
  });

  it('shows unavailable runtime copy when runtime state is missing', async () => {
    vi.mocked(getDebugState).mockResolvedValue(mockUnavailableStateResponse);

    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');

    expect(wrapper.text()).toContain('Runtime state is unavailable. Start the runtime or restore runtime state before using pause/resume controls.');
  });

  it('shows unauthorized banner and disables controls on 401', async () => {
    vi.mocked(listNotes).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));
    vi.mocked(getDebugState).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));

    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');

    expect(wrapper.text()).toContain('Unauthorized. Provide a valid Saivage API token and refresh the page.');
  });

  it('shows exact stale queue action message after 404 note deletion and refreshes notes', async () => {
    vi.mocked(deleteNote).mockRejectedValueOnce(new ApiError(404, 'Note not found', {}));
    vi.mocked(listNotes).mockResolvedValueOnce(mockNotesResponse).mockResolvedValueOnce({ notes: [], total: 0 });

    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');

    const button = wrapper.find('[aria-label="Delete note note-1"]');
    await button.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('That note is no longer in the unhandled queue. Refreshing notes.');
    expect(wrapper.text()).not.toContain('This panel may be stale. Refresh to reconcile with server state.');
    expect(wrapper.text()).toContain('No unhandled operator notes.');
  });

  it('shows partial refresh warning while preserving successful operator data', async () => {
    vi.mocked(listNotes).mockResolvedValue(mockNotesResponse);
    vi.mocked(getDebugState)
      .mockResolvedValueOnce(mockStateResponse)
      .mockRejectedValueOnce(new Error('state failed'));

    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');

    expect(wrapper.text()).toContain('Notes refreshed, but runtime state could not be loaded.');
    expect(wrapper.text()).toContain('Check runtime status before proceeding.');
  });
});
