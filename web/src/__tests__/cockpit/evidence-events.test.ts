import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import EventsPanel from '../../components/system/EventsPanel.vue';
import ProvidersPanel from '../../components/system/ProvidersPanel.vue';
import ActionsPanel from '../../components/system/ActionsPanel.vue';
import CardEvidenceFacet from '../../components/cockpit/CardEvidenceFacet.vue';
import { useEventsStore } from '../../stores/events';
import { useSystemResourcesStore } from '../../stores/systemResources';
import { agentSession } from './fixtures';

const api = vi.hoisted(() => ({
  listEvents: vi.fn(),
  listCardHistory: vi.fn(),
  listRecordHistory: vi.fn(),
  listAgentConversationVersions: vi.fn(),
  listCardRecords: vi.fn(),
  getCardAgentSessions: vi.fn(),
  getCard: vi.fn(),
  getConfig: vi.fn(),
  listProviders: vi.fn(),
  listControlActions: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  listEvents: api.listEvents,
  listCardHistory: api.listCardHistory,
  listRecordHistory: api.listRecordHistory,
  listAgentConversationVersions: api.listAgentConversationVersions,
  listCardRecords: api.listCardRecords,
  getCardAgentSessions: api.getCardAgentSessions,
  getCard: api.getCard,
  getConfig: api.getConfig,
  listProviders: api.listProviders,
  listControlActions: api.listControlActions,
}));

vi.mock('../../stores/sync', () => ({
  useSyncStore: () => ({
    connectionState: 'offline',
    openCardAgentSessions: (_cardId: string, callback: () => Promise<void>) => {
      void callback();
      return () => {};
    },
  }),
}));

function diagnosticEvent(id: string, cardId: string | null) {
  return { id, kind: 'runtime_diagnostic' as const, timestamp: `2026-09-24T12:0${id.length}:00.000Z`, error_message: `boom ${id}`, ...(cardId ? { card_id: cardId } : {}) };
}

describe('events store bounded observation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('reads the card-scoped newest tail with limit 50 and offset 0', async () => {
    api.listEvents.mockResolvedValue({ events: [diagnosticEvent('e1', 'card-a')], total: 120 });
    const store = useEventsStore();
    await store.read({ cardId: 'card-a' }, { mode: 'newest_tail' });
    expect(api.listEvents).toHaveBeenCalledWith({ cardId: 'card-a', selection: 'newest_tail', limit: 50, offset: 0, signal: expect.any(AbortSignal) });
    const state = store.scope({ cardId: 'card-a' });
    expect(state.events).toHaveLength(1);
    expect(state.total).toBe(120);
    expect(state.events[0]).toMatchObject({ id: 'e1' });
  });

  it('retains the last accepted observation when a later read fails, with a distinct refresh error', async () => {
    api.listEvents.mockResolvedValueOnce({ events: [diagnosticEvent('e1', null)], total: 1 });
    const store = useEventsStore();
    await store.read({ cardId: null }, { mode: 'newest_tail' });
    api.listEvents.mockRejectedValueOnce(new Error('read failed'));
    await store.refresh({ cardId: null });
    const state = store.scope({ cardId: null });
    expect(state.events).toHaveLength(1);
    expect(state.refreshError).toBe('read failed');
    expect(state.error).toBeNull();
  });

  it('browses an explicit oldest page as a fresh bounded observation', async () => {
    api.listEvents.mockResolvedValue({ events: [], total: 30 });
    const store = useEventsStore();
    await store.browseOldest({ cardId: null }, 50);
    expect(api.listEvents).toHaveBeenCalledWith({ cardId: undefined, selection: 'oldest_page', limit: 50, offset: 50, signal: expect.any(AbortSignal) });
    expect(store.scope({ cardId: null }).mode).toBe('oldest_page');
  });
});

describe('evidence facet and system sections', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setActivePinia(createPinia());
    vi.clearAllMocks();
    api.listCardHistory.mockResolvedValue({
      card_id: 'card-a',
      versions: [{ entry_id: '00000000-0000-4000-8000-000000000001', version: 2, published_at: '2026-09-24T12:00:00.000Z', artifact_kind: 'card-version', change: null }],
      total: 1,
    });
    api.listCardRecords.mockResolvedValue({ card_id: 'card-a', records: [{ name: 'brief.md', format: 'markdown', schema: 'brief.v1', bootstrap: true, current: null }] });
    api.getCardAgentSessions.mockResolvedValue({ sessions: [] });
    api.getCard.mockResolvedValue({ card: { id: 'card-a', type: 'code', title: 'Card A', lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, version_seq: 1, urgency: 'normal', created_at: '2026-09-24T12:00:00.000Z', updated_at: '2026-09-24T12:00:00.000Z', allowedActions: [] } });
    api.listEvents.mockResolvedValue({ events: [diagnosticEvent('e9', 'card-a')], total: 9 });
  });

  it('exposes the card-version catalog with coverage-honest links and the card events tail', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const cardStoreUse = await import('../../stores/cards');
    const cardStore = cardStoreUse.useCardStore(pinia);
    await cardStore.fetchCardDetail('card-a');
    const wrapper = mount(CardEvidenceFacet, {
      props: { cardId: 'card-a' },
      global: { plugins: [pinia], stubs: { RouterLink: { template: '<a><slot /></a>', props: ['to'] } } },
    });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();

    const versions = wrapper.get('[data-testid="evidence-card-versions"]');
    expect(versions.text()).toContain('v2');
    expect(versions.text()).toContain('change metadata unavailable');

    const events = wrapper.get('[data-testid="evidence-events"]');
    expect(events.text()).toContain('boom e9');
    expect(events.text()).toContain('card card-a');
    expect(api.listEvents).toHaveBeenCalledWith({ cardId: 'card-a', selection: 'newest_tail', limit: 50, offset: 0, signal: expect.any(AbortSignal) });
    wrapper.unmount();
  });

  it('renders the unscoped system events panel with refresh and explicit oldest-page browsing', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    api.listEvents.mockResolvedValue({ events: [diagnosticEvent('a1', null)], total: 200 });
    const wrapper = mount(EventsPanel, { props: { scope: { cardId: null } }, global: { plugins: [pinia], stubs: { RouterLink: { template: '<a><slot /></a>', props: ['to'] } } } });
    await flushPromises();
    expect(wrapper.text()).toContain('Showing the newest events: 1 of 200 retained events');
    expect(wrapper.text()).toContain('no card filter');

    await wrapper.get('[data-testid="events-refresh"]').trigger('click');
    await flushPromises();
    expect(api.listEvents).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('carries the exact numeric segment from Evidence into its session link', async () => {
    api.getCardAgentSessions.mockResolvedValue({ sessions: [agentSession('agent:executor:card-a')] });
    api.listAgentConversationVersions.mockResolvedValue({ versions: [{ entry_id: 'catalog-entry', version: 7, genesis_kind: 'compacted' }] });
    const pinia = createPinia();
    const wrapper = mount(CardEvidenceFacet, { props: { cardId: 'card-a' }, global: { plugins: [pinia], stubs: { RouterLink: { name: 'RouterLink', template: '<a><slot /></a>', props: ['to'] } } } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === 'Load segment catalog')!.trigger('click');
    await flushPromises();
    const link = wrapper.findAllComponents({ name: 'RouterLink' }).find((link) => link.text().includes('Segment 7'))!;
    expect(link.props('to')).toEqual({ name: 'agent-detail', params: { id: 'agent:executor:card-a' }, query: { segment: '7' } });
    wrapper.unmount();
  });

  it('observes process-local provider availability with explicit refresh', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    api.listProviders.mockResolvedValue({
      availabilityScope: 'process_local_reset_on_restart',
      providers: {
        primary: {
          priority: 1,
          models: ['model-one'],
          candidateCount: 2,
          availableCandidateCount: 1,
          capabilitiesByModel: {},
          availability: [
            { candidate: { provider: 'primary', account: null, model: 'model-one' }, state: 'HEALTHY' },
            { candidate: { provider: 'primary', account: 'aux', model: 'model-one' }, state: 'COOLING', untilMs: 1780000000000 },
          ],
        },
      },
    });
    const wrapper = mount(ProvidersPanel, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain('process_local_reset_on_restart');
    expect(wrapper.text()).toContain('HEALTHY');
    expect(wrapper.text()).toContain('COOLING');
    await wrapper.get('[data-testid="providers-refresh"]').trigger('click');
    await flushPromises();
    expect(api.listProviders).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('renders each bounded direct-control outcome truthfully with no synthetic card links', async () => {
    const results = [
      { operation: 'pause_runtime', outcome: 'returned', runtime_status: 'pausing' },
      { operation: 'resume_runtime', outcome: 'returned', runtime_status: 'running' },
      { operation: 'stop_project', outcome: 'returned', status: 'stopped', contained: true },
      { operation: 'stop_project', outcome: 'returned', status: 'stopped', contained: false },
      { operation: 'restart_server', outcome: 'restart_scheduled' },
      ...['pause_runtime', 'resume_runtime', 'stop_project'].map((operation) => ({ operation, outcome: 'rejected', reason: 'body_not_allowed' })),
      { operation: 'restart_server', outcome: 'rejected', reason: 'restart_unavailable' },
    ];
    api.listEvents.mockResolvedValue({ events: results.map((result, index) => ({ id: String(index), kind: 'operator_runtime_control', actor: 'operator', surface: 'operator_api', timestamp: '2026-10-02T12:00:00.000Z', result })), total: results.length });
    const wrapper = mount(EventsPanel, { props: { scope: { cardId: null } }, global: { plugins: [createPinia()] } });
    await flushPromises();
    const summaries = wrapper.findAll('.events-summary').map((row) => row.text());
    expect(summaries).toEqual([
      'Pause returned runtime status: pausing', 'Resume returned runtime status: running',
      'Stop returned stopped; execution contained (contained: true)',
      'Stop returned stopped; execution not newly contained (contained: false)',
      'Restart scheduled — shutdown and replacement readiness not established',
      'pause_runtime rejected: request body not allowed', 'resume_runtime rejected: request body not allowed', 'stop_project rejected: request body not allowed', 'restart_server rejected: restart unavailable',
    ]);
    expect(wrapper.find('.events-card-link').exists()).toBe(false);
    expect(wrapper.text()).toContain('pre-handler denials, thrown failures and transport loss have no promised row');
    wrapper.unmount();
  });

  it('lists retained settled control actions with ok/denied/error results', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    api.listControlActions.mockResolvedValue({
      control_actions: [
        { id: 'act-1', actor: 'analyst', surface: 'analyst-chat', action: 'reopen_card', target_kind: 'card', target_id: 'card-a', params_summary: 'reopen', outcome: 'ok', outcome_summary: 'reopened', created_at: '2026-09-24T12:00:00.000Z' },
        { id: 'act-2', actor: 'operator', surface: 'operator-ui', action: 'restart_server', target_kind: 'runtime', target_id: null, params_summary: 'RESTART SERVER', outcome: 'denied', outcome_summary: 'authentication disabled', created_at: '2026-09-24T12:01:00.000Z' },
      ],
      total: 2,
    });
    const wrapper = mount(ActionsPanel, { global: { plugins: [pinia] } });
    await flushPromises();
    const rows = wrapper.findAll('[data-testid="actions-list"] li');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.attributes('data-result')).toBe('ok');
    expect(rows[1]!.attributes('data-result')).toBe('denied');
    wrapper.unmount();
  });

  it('keeps system resources read-only with no invalidation registration', () => {
    const store = useSystemResourcesStore();
    expect(Object.keys(store)).toEqual(expect.arrayContaining(['fetchConfig', 'fetchProviders', 'fetchActions']));
    expect(Object.keys(store)).not.toContain('invalidate');
    expect(Object.keys(store)).not.toContain('subscribe');
  });
});
