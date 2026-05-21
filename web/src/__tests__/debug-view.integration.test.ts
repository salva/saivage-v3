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
    terminateProcess: vi.fn(),
    getMcpTools: vi.fn(),
    listNotes: vi.fn(),
    acknowledgeNote: vi.fn(),
    deleteNote: vi.fn(),
    clearAllNotes: vi.fn(),
    pauseRuntime: vi.fn(),
    resumeRuntime: vi.fn(),
    listNotifications: vi.fn(),
    acknowledgeNotification: vi.fn(),
    listControlActions: vi.fn(),
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
  listNotifications,
  acknowledgeNotification,
  listControlActions,
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
  NotificationsListResponse,
  ControlActionsListResponse,
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
  cards: [{ id: 'card-active-1', type: 'goal', parent: null, status: 'active', title: 'Active goal card', priority: 5, depends_on: [], blocks: [] }],
  totalCards: 1,
};
const mockFrozenStateResponse: DebugStateResponse = { ...mockStateResponse, runtime: { ...mockStateResponse.runtime!, status: 'frozen', paused: true, frozen_reason: 'operator handoff' } };
const mockUnavailableStateResponse: DebugStateResponse = { ...mockStateResponse, runtime: null };
const mockErrorsResponse: DebugErrorsResponse = { errors: [{ source: 'runtime', type: 'timeout', severity: 'error', message: 'Process proc-1 timed out after 30s', timestamp: '2025-06-01T10:01:00Z' }], total: 1 };
const mockTimelineResponse: DebugTimelineResponse = { events: [{ id: 'evt-process-launched', kind: 'process_launched', card_id: 'card-active-1', timestamp: '2025-06-01T09:56:00Z', command: 'npm test' }], total: 1 };
const mockProcessesResponse: ProcessListResponse = { processes: [{ id: 'proc-int-1', card_id: 'card-active-1', command: 'npm test', cwd: '.saivage-work/processes/proc-int-1', status: 'running', started_at: '2025-06-01T10:00:00Z', ended_at: null, exit_code: null, timed_out: false, owner: 'agent', session_id: 'session-1', logs: { stdout: '.saivage-work/processes/proc-int-1/stdout.log', stderr: '.saivage-work/processes/proc-int-1/stderr.log', combined: '.saivage-work/processes/proc-int-1/combined.log' }, control: { can_view_logs: true, can_terminate: true, terminate_status: 'live-attached', terminate_degraded: false, terminate_reason: 'Process is running and attached to this server; termination can be requested.' } }] };
const mockMcpResponse: McpToolsResponse = { tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }], servers: ['filesystem'], invocationStats: { 'filesystem:read_file': { total: 10, success: 10, error: 0 } }, serverDetails: [{ name: 'filesystem', transport: 'stdio', status: 'running', toolCount: 1, tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' }, stats: { total: 10, success: 10, error: 0 } }] }] };
const mockDoctorOk: DoctorResponse = { status: 'ok', checks: [{ name: 'card-index-check', passed: true }], issues: [] };
const mockSupervisionResponse: SupervisionResponse = { reviews: [], quarantine: [], stats: { total: 0, blocked: 0, passed: 0, sanitized: 0, byRisk: {}, bySourceKind: {} } };
const mockNotesResponse: NotesListResponse = { notes: [{ card_id: 'card-active-1', note_id: 'note-1', timestamp: '2025-06-01T10:03:00Z', kind: 'directive', note: { id: 'note-1', card_id: 'card-active-1', author: 'planner', timestamp: '2025-06-01T10:03:00Z', content: 'Check runtime status before proceeding.', kind: 'directive', handled: false } }], total: 1 };
const mockNotificationsResponse: NotificationsListResponse = { notifications: [{ id: 'n-1', session_id: null, kind: 'card_changed', severity: 'warn', payload_summary: 'Active card changed', related_card_id: 'card-active-1', source_actor: 'analyst', source_surface: 'rest', created_at: '2025-06-01T10:02:00Z', delivered_at: null, acknowledged_at: null }], total: 1 };
const mockControlActionsResponse: ControlActionsListResponse = { control_actions: [], total: 0 };

function makeRouter() { return createRouter({ history: createWebHistory(), routes: [{ path: '/files', name: 'files', component: { template: '<div>Files</div>' } }] }); }
function setupCommonMocks(): void {
  vi.mocked(getDebugState).mockResolvedValue(mockStateResponse);
  vi.mocked(getDebugErrors).mockResolvedValue(mockErrorsResponse);
  vi.mocked(getDebugTimeline).mockResolvedValue(mockTimelineResponse);
  vi.mocked(listProcesses).mockResolvedValue(mockProcessesResponse);
  vi.mocked(getMcpTools).mockResolvedValue(mockMcpResponse);
  vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
  vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervisionResponse);
  vi.mocked(listNotes).mockResolvedValue(mockNotesResponse);
  vi.mocked(listNotifications).mockResolvedValue(mockNotificationsResponse);
  vi.mocked(listControlActions).mockResolvedValue(mockControlActionsResponse);
  vi.mocked(acknowledgeNotification).mockResolvedValue({ notification: { id: 'n-1' } as any });
  vi.mocked(acknowledgeNote).mockResolvedValue({ note: { ...mockNotesResponse.notes[0].note!, handled: true, handled_at: '2025-06-01T10:04:00Z' } });
  vi.mocked(deleteNote).mockResolvedValue(undefined);
  vi.mocked(clearAllNotes).mockResolvedValue({ deleted: 1, noteIds: ['note-1'] });
  vi.mocked(pauseRuntime).mockResolvedValue({ ...mockStateResponse.runtime!, status: 'paused', paused: true });
  vi.mocked(resumeRuntime).mockResolvedValue({ ...mockStateResponse.runtime!, status: 'running', paused: false });
}
async function mountDebugView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = makeRouter();
  const wrapper = mount(DebugView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper;
}
function findTabButton(wrapper: ReturnType<typeof mount>, label: string) { return wrapper.findAll('.debug-tab').find((t) => t.text() === label); }
async function clickTab(wrapper: ReturnType<typeof mount>, label: string) { const tab = findTabButton(wrapper, label); if (!tab) throw new Error(`Tab not found: ${label}`); await tab.trigger('click'); await flushPromises(); }

describe('DebugView — integration', () => {
  beforeEach(() => { vi.clearAllMocks(); mockPush.mockClear(); setupCommonMocks(); vi.spyOn(window, 'confirm').mockReturnValue(true); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders operator control tab and fetches operator APIs on open', async () => {
    const wrapper = await mountDebugView();
    expect(wrapper.findAll('.debug-tab').map((t) => t.text())).toContain('Operator Control');
    await clickTab(wrapper, 'Operator Control');
    expect(listNotes).toHaveBeenCalled();
    expect(listNotifications).toHaveBeenCalled();
    expect(getDebugState).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Runtime Diagnostics');
    expect(wrapper.text()).toContain('Runtime Console owns execution controls');
    expect(wrapper.text()).not.toContain('Runtime Controls');
    expect(wrapper.text()).toContain('Notifications Inbox (1)');
    expect(wrapper.text()).toContain('Active card changed');
    expect(wrapper.text()).toContain('Actionable runtime issues');
    expect(wrapper.text()).toContain('Runtime Console for command errors');
    expect(wrapper.text()).toContain('Operator Notes (1)');
  });

  it('shows empty notifications state', async () => {
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [], total: 0 });
    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');
    expect(wrapper.text()).toContain('No pending operator notifications.');
  });

  it('acknowledges an operator notification', async () => {
    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');
    await wrapper.find('[aria-label="Acknowledge notification n-1"]').trigger('click');
    await flushPromises();
    expect(acknowledgeNotification).toHaveBeenCalledWith('n-1');
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

  it('does not expose pause or resume execution controls from DebugView', async () => {
    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');
    expect(wrapper.findAll('button').map((b) => b.text())).not.toContain('Pause runtime');
    expect(wrapper.findAll('button').map((b) => b.text())).not.toContain('Resume runtime');
    expect(wrapper.text()).toContain('DebugView is diagnostic-only. Runtime Console owns execution controls');
    expect(pauseRuntime).not.toHaveBeenCalled();
    expect(resumeRuntime).not.toHaveBeenCalled();
  });

  it('shows frozen diagnostic guidance without a generic resume control', async () => {
    vi.mocked(getDebugState).mockResolvedValue(mockFrozenStateResponse);
    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');
    expect(wrapper.findAll('button').map((b) => b.text())).not.toContain('Resume runtime');
    expect(wrapper.text()).toContain('Frozen runtime recovery is coordinated from Runtime Console after reviewing the freeze manifest.');
  });

  it('shows unavailable runtime copy when runtime state is missing', async () => {
    vi.mocked(getDebugState).mockResolvedValue(mockUnavailableStateResponse);
    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');
    expect(wrapper.text()).toContain('Runtime state is unavailable. Open Dashboard → Runtime Console to start project execution or inspect recovery state.');
    expect(wrapper.text()).toContain('Runtime diagnostics are unavailable because runtime state is not initialized.');
  });

  it('shows unauthorized banner and disables controls on 401', async () => {
    vi.mocked(listNotes).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));
    vi.mocked(getDebugState).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));
    vi.mocked(listNotifications).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));
    vi.mocked(listControlActions).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));
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
    vi.mocked(getDebugState).mockResolvedValueOnce(mockStateResponse).mockRejectedValueOnce(new Error('state failed'));
    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');
    expect(wrapper.text()).toContain('This panel may be stale. Refresh to reconcile with server state.');
    expect(wrapper.text()).toContain('Check runtime status before proceeding.');
  });

  it('renders the documented timeline event kinds by default, narrows with the multi-select filter, and resets to show all', async () => {
    const requiredKinds = [
      'model_selected',
      'invocation_failed',
      'invocation_succeeded',
      'retry_attempted',
      'dispatched',
      'planner_started',
      'planner_completed',
      'reviewer_started',
      'reviewer_completed',
      'card_status_changed',
      'directive_recorded',
      'directive_consumed',
      'paused',
      'resumed',
      'frozen',
      'unfrozen',
      'stuck_verdict',
    ];
    vi.mocked(getDebugTimeline).mockResolvedValue({
      events: requiredKinds.map((kind, index) => ({
        id: `evt-${kind}`,
        kind,
        session_id: `session-${index}`,
        timestamp: `2025-06-01T10:${String(index).padStart(2, '0')}:00Z`,
      })),
      total: requiredKinds.length,
    });

    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Timeline');

    expect(wrapper.text()).toContain('No selection shows all event kinds.');
    expect(wrapper.findAll('select[aria-label="Filter timeline event kinds"] option')).toHaveLength(requiredKinds.length);
    const renderedKinds = wrapper.findAll('.tl-event-type').map((node) => node.text());
    expect(renderedKinds).toHaveLength(requiredKinds.length);
    for (const kind of requiredKinds) {
      expect(renderedKinds).toContain(kind.replace(/_/g, ' '));
    }

    const select = wrapper.find('select[aria-label="Filter timeline event kinds"]');
    await select.setValue(['invocation_failed', 'model_selected']);
    await flushPromises();
    expect(wrapper.findAll('.tl-event-type').map((node) => node.text())).toEqual(['invocation failed', 'model selected']);
    expect(wrapper.text()).not.toContain('planner started');

    await wrapper.find('.timeline-filter .filter-chip').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.tl-event-type').map((node) => node.text())).toHaveLength(requiredKinds.length);
  });

  it('groups invocation_failed, suffix error/failed, and error-field events by session with count and latest message', async () => {
    vi.mocked(getDebugErrors).mockResolvedValue({ errors: [], total: 0 });
    vi.mocked(getDebugTimeline).mockResolvedValue({
      events: [
        { id: 'evt-old', kind: 'invocation_failed', session_id: 'planner:1', timestamp: '2025-06-01T10:00:00Z', error_message: 'HTTP 401 old failure' },
        { id: 'evt-error-suffix', kind: 'tool_error', session_id: 'planner:1', timestamp: '2025-06-01T10:01:00Z', error: 'Tool crashed suffix error' },
        { id: 'evt-failed-suffix', kind: 'reviewer_failed', session_id: 'planner:1', timestamp: '2025-06-01T10:04:00Z', message: 'Reviewer failed latest' },
        { id: 'evt-message-field', kind: 'model_selected', session_id: 'reviewer:2', timestamp: '2025-06-01T10:02:00Z', error_message: 'Provider config missing' },
        { id: 'evt-error-field', kind: 'directive_recorded', session_id: 'executor:3', timestamp: '2025-06-01T10:03:00Z', error: 'Directive write failed' },
        { id: 'evt-ok', kind: 'invocation_succeeded', session_id: 'planner:1', timestamp: '2025-06-01T10:05:00Z' },
      ],
      total: 6,
    });

    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Errors');

    expect(wrapper.text()).toContain('planner:1 (3)');
    expect(wrapper.text()).toContain('Reviewer failed latest');
    expect(wrapper.text()).toContain('Tool crashed suffix error');
    expect(wrapper.text()).toContain('HTTP 401 old failure');
    expect(wrapper.text()).toContain('reviewer:2 (1)');
    expect(wrapper.text()).toContain('Provider config missing');
    expect(wrapper.text()).toContain('executor:3 (1)');
    expect(wrapper.text()).toContain('Directive write failed');
    expect(wrapper.text()).not.toContain('No errors recorded.');
  });


  it('keeps Notifications Inbox analyst label visually separated from Refresh', async () => {
    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Operator Control');
    const actions = wrapper.findComponent({ name: 'NotificationsPanel' }).find('.operator-actions-inline');
    expect(actions.exists()).toBe(true);
    expect(actions.attributes('class')).toContain('operator-actions-inline');
    expect(actions.find('.filter-chip').text()).toBe('by analyst');
    expect(actions.find('.sv-fetch-btn').text()).toBe('Refresh');
  });

  it('redacts provider-like secret values in Debug Errors and Timeline details', async () => {
    const rawToken = 'synthetic-token-value-debug-49';
    const rawApiKey = 'synthetic-api-key-value-debug-49';
    const rawAuthorization = 'Bearer synthetic-authorization-value-debug-49';
    vi.mocked(getDebugErrors).mockResolvedValue({
      errors: [{ source: 'planner:redaction', type: 'invocation_failed', severity: 'warning', message: `Provider failed: {"token":"${rawToken}"}`, details: `{"api_key":"${rawApiKey}","authorization":"${rawAuthorization}"}`, timestamp: '2025-06-01T10:01:00Z' }],
      total: 1,
    });
    vi.mocked(getDebugTimeline).mockResolvedValue({
      events: [{ id: 'evt-secret', kind: 'invocation_failed', session_id: 'planner:redaction', timestamp: '2025-06-01T10:02:00Z', error_message: `Provider failed: {"token":"${rawToken}","api_key":"${rawApiKey}","authorization":"${rawAuthorization}"}`, provider_error: { token: rawToken, api_key: rawApiKey, authorization: rawAuthorization, safe: 'visible' } }],
      total: 1,
    });

    const wrapper = await mountDebugView();
    await clickTab(wrapper, 'Errors');
    expect(wrapper.text()).not.toContain(rawToken);
    expect(wrapper.text()).not.toContain(rawApiKey);
    expect(wrapper.text()).not.toContain(rawAuthorization);
    expect(wrapper.text()).toContain('[REDACTED]');

    await clickTab(wrapper, 'Timeline');
    expect(wrapper.text()).not.toContain(rawToken);
    expect(wrapper.text()).not.toContain(rawApiKey);
    expect(wrapper.text()).not.toContain(rawAuthorization);
    expect(wrapper.text()).toContain('[REDACTED]');
    expect(wrapper.text()).toContain('visible');
  });

});
