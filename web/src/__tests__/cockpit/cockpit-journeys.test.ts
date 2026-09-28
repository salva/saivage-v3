import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import CockpitView from '../../views/CockpitView.vue';
import SessionView from '../../views/SessionView.vue';
import RestartServerDialog from '../../components/cockpit/RestartServerDialog.vue';
import CardFlowHeader from '../../components/cockpit/CardFlowHeader.vue';
import { useRuntimeStore } from '../../stores/runtime';
import { useCardStore } from '../../stores/cards';
import { createOperatorRouter } from '../../router';
import {
  agentSession,
  cardDetail,
  cyclicCodeGraph,
  noCurrentRuntimeStatus,
  runtimeStatusSnapshot,
  serverAvailability,
} from './fixtures';

const api = vi.hoisted(() => ({
  getRuntimeState: vi.fn(),
  getRuntimeStatus: vi.fn(),
  getCard: vi.fn(),
  getCardChildren: vi.fn(),
  getCardAgentSessions: vi.fn(),
  getAgentSession: vi.fn(),
  getDebugGraphs: vi.fn(),
  listCardRecords: vi.fn(),
  getCardRecord: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  getRuntimeState: api.getRuntimeState,
  getRuntimeStatus: api.getRuntimeStatus,
  getCard: api.getCard,
  getCardChildren: api.getCardChildren,
  getCardAgentSessions: api.getCardAgentSessions,
  getAgentSession: api.getAgentSession,
  getDebugGraphs: api.getDebugGraphs,
  listCardRecords: api.listCardRecords,
  getCardRecord: api.getCardRecord,
}));

vi.mock('../../stores/sync', () => ({
  useSyncStore: () => ({
    connectionState: 'offline',
    connect: vi.fn(),
    registerResource: vi.fn(() => vi.fn()),
    openCardAgentSessions: (_cardId: string, callback: () => Promise<void>) => {
      void callback();
      return () => {};
    },
    openAgents: vi.fn(() => vi.fn()),
    openConversation: vi.fn(() => vi.fn()),
  }),
}));

const deepChildStatus = runtimeStatusSnapshot();
const runningState = {
  projectId: 'cockpit-journeys',
  runtime: { status: 'running', project_id: 'cockpit-journeys', pid: 4242, started_at: '2026-09-24T12:00:00.000Z', updated_at: '2026-09-24T12:00:00.000Z', current_card_id: 'card-a-b' },
  serverAvailability: serverAvailability(),
};

function installDefaultFixtureApi(): void {
  api.getRuntimeState.mockResolvedValue(runningState);
  api.getRuntimeStatus.mockResolvedValue(deepChildStatus);
  api.getCard.mockImplementation(async (id: string) => ({
    card: cardDetail(id, id === 'card-a' ? { type: 'goal', title: 'Waiting parent goal' } : { type: 'code', title: 'Running deep child' }),
  }));
  api.getCardChildren.mockImplementation(async (id: string) => {
    if (id === 'project') return { parent: { id: 'project', type: 'project', title: 'Project', status: 'running', permitted_child_types: ['goal'] }, children: [{ id: 'card-a', type: 'goal', title: 'Waiting parent goal', status: 'running', permitted_child_types: ['code'] }] };
    if (id === 'card-a') return { parent: { id: 'card-a', type: 'goal', title: 'Waiting parent goal', status: 'running', permitted_child_types: ['code'] }, children: [{ id: 'card-a-b', type: 'code', title: 'Running deep child', status: 'running', permitted_child_types: [] }] };
    return { parent: { id, type: 'code', title: id, status: 'backlog', permitted_child_types: [] }, children: [] };
  });
  api.getCardAgentSessions.mockResolvedValue({
    sessions: [
      agentSession('agent:executor:card-a-b', { status: 'active', activity: 'busy' }),
      agentSession('agent:planner:card-a', { status: 'inactive', activity: 'idle' }),
    ],
  });
  api.getAgentSession.mockImplementation(async (id: string) => ({
    session: agentSession(id),
  }));
  api.getDebugGraphs.mockResolvedValue({ graphs: [cyclicCodeGraph()], global_agents: [] });
  api.listCardRecords.mockResolvedValue({
    card_id: 'card-a-b',
    records: [{ name: 'brief.md', format: 'markdown', schema: 'brief.v1', bootstrap: true, current: null }],
  });
  api.getCardRecord.mockImplementation(async (cardId: string, name: string) => ({
    card_id: cardId,
    record: {
      name,
      head_version: 1,
      head_entry_id: '11111111-1111-4111-8111-111111111111',
      state: 'closed',
      accepted: { source_version: 1, source_entry_id: '11111111-1111-4111-8111-111111111111', committed_at: '2026-09-24T12:00:00.000Z', writer_agent: 'analyst', card_version_seq: 1, content: 'Complete the represented work.', content_sha256: 'a'.repeat(64), size_bytes: 30 },
      draft: null,
      discarded: null,
      effective_content_source: 'accepted',
    },
  }));
}

async function mountAt(path: string, pinia: ReturnType<typeof createPinia>): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const router = createOperatorRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const wrapper = mount(CockpitView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
  return { wrapper, router };
}

describe('cockpit acceptance fixtures', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    installDefaultFixtureApi();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('identifies chain, position, and true participants for a running deep child with a waiting parent', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const runtimeStore = useRuntimeStore(pinia);
    await runtimeStore.fetchState();
    const cardStore = useCardStore(pinia);
    await cardStore.ensureRoot();
    const { wrapper } = await mountAt('/cards/card-a-b', pinia);

    expect(wrapper.get('[data-testid="card-flow-title"]').text()).toBe('Running deep child');
    expect(wrapper.get('[data-testid="card-flow-id"]').text()).toBe('card-a-b');
    expect(wrapper.get('.card-flow-header').findAll('.status-badge')).toHaveLength(1);
    expect(wrapper.get('[data-testid="card-flow-position"]').text()).toBe("Observed workflow step: executor's step in this workflow.");
    const chain = wrapper.get('[data-testid="card-flow-chain"]').text();
    expect(chain).toContain('Project');
    expect(chain).toContain('Waiting parent goal');
    expect(chain).toContain('Running deep child');

    const participants = wrapper.get('[data-testid="overview-participants"]').text();
    expect(participants).toContain('Active — working now');
    expect(participants).toContain('Idle — no current work');
    expect(wrapper.findAll('.session-details').every((details) => details.attributes('open') === undefined)).toBe(true);
    expect(participants).not.toContain('is executing');

    wrapper.unmount();
  });

  it('keeps an inspected subject while showing the distinct current work with a deliberate jump action', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const runtimeStore = useRuntimeStore(pinia);
    await runtimeStore.fetchState();
    const cardStore = useCardStore(pinia);
    await cardStore.ensureRoot();
    const { wrapper, router } = await mountAt('/cards/card-a', pinia);

    expect(wrapper.get('[data-testid="cockpit-inspecting"]').text()).toBe('Inspecting Waiting parent goal');
    const note = wrapper.get('[data-testid="cockpit-subject-bar"]').text();
    expect(note).toContain('Current work:');
    expect(note).toMatch(/Running deep child|card-a-b/);

    await wrapper.get('[data-testid="go-to-current-work"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/cards/card-a-b');

    wrapper.unmount();
  });

  it('has no card-tree search on shared cockpit routes and preserves exact row selection', async () => {
    for (const path of ['/', '/cards', '/cards/card-a']) {
      const pinia = createPinia();
      setActivePinia(pinia);
      await useRuntimeStore(pinia).fetchState();
      await useCardStore(pinia).ensureRoot();
      const { wrapper } = await mountAt(path, pinia);

      const cardTree = wrapper.get('aside[aria-label="Card tree"]');
      expect(cardTree.find('input[type="search"]').exists()).toBe(false);
      wrapper.unmount();
    }

    const pinia = createPinia();
    setActivePinia(pinia);
    await useRuntimeStore(pinia).fetchState();
    await useCardStore(pinia).ensureRoot();
    const { wrapper, router } = await mountAt('/cards', pinia);
    const parentRow = wrapper.findAll('.tree-node').find((row) => row.get('.node-title').text() === 'Waiting parent goal');
    expect(parentRow).toBeDefined();

    await parentRow!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/cards/card-a');
    wrapper.unmount();
  });

  it('shows accepted absence at home when no current work exists', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    api.getRuntimeStatus.mockResolvedValue(noCurrentRuntimeStatus());
    api.getRuntimeState.mockResolvedValue({ ...runningState, runtime: null });
    const runtimeStore = useRuntimeStore(pinia);
    await runtimeStore.fetchState();
    const cardStore = useCardStore(pinia);
    await cardStore.ensureRoot();
    const { wrapper } = await mountAt('/', pinia);

    expect(wrapper.get('[data-testid="home-no-current"]').text()).toContain('No current work');
    expect(wrapper.text()).not.toContain('Executing');
    wrapper.unmount();
  });

  it('keeps an unknown home honest when the initial runtime observation fails', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    api.getRuntimeState.mockRejectedValue(new Error('network down'));
    api.getRuntimeStatus.mockRejectedValue(new Error('network down'));
    const runtimeStore = useRuntimeStore(pinia);
    await runtimeStore.fetchState().catch(() => {});
    const { wrapper } = await mountAt('/', pinia);

    expect(wrapper.text()).toContain('Runtime observation failed');
    expect(wrapper.text()).not.toContain('No current work');
    wrapper.unmount();
  });

  it('labels configured outcomes for the observed node, including cycles, as possibilities not history', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(CardFlowHeader, {
      props: {
        cardId: 'card-a-b',
        detail: cardDetail('card-a-b'),
        position: { cardType: 'code', stateId: 'execute', kind: 'node', nodeId: 'execute', executionOrdinal: 12 },
      },
      global: { plugins: [pinia], stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    });
    await flushPromises();

    const technical = wrapper.get('[data-testid="card-flow-technical"]');
    expect(technical.attributes('open')).toBeUndefined();
    const outcomes = wrapper.get('[data-testid="card-flow-outcomes"]').text();
    expect(outcomes).toContain('done (default) → terminal DONE');
    expect(outcomes).toContain('needs-repair (default) → node repair');
    expect(wrapper.text()).not.toContain('will proceed');

    const graphText = wrapper.get('.flow-graph-details').text();
    expect(graphText).toContain('repair —needs-repair (default)→ node execute');
    expect(graphText).toContain('executor — node execute');
    expect(graphText).toContain('executor — node repair');
    wrapper.unmount();
  });

  it('uses neutral observed wording for ready, entry, terminal, and absent workflow positions', async () => {
    const cases = [
      [{ cardType: 'code', stateId: 'BACKLOG', kind: 'ready' as const }, 'Ready for a configured workflow entry.'],
      [{ cardType: 'code', stateId: 'BACKLOG', kind: 'entry' as const, entry: 'BACKLOG' }, 'At a configured workflow entry.'],
      [{ cardType: 'code', stateId: 'DONE', kind: 'terminal' as const, terminal: 'DONE' }, 'At a configured terminal; this is not lifecycle acceptance.'],
      [null, 'No current workflow position is available.'],
    ] as const;

    for (const [position, wording] of cases) {
      const pinia = createPinia();
      setActivePinia(pinia);
      const wrapper = mount(CardFlowHeader, {
        props: { cardId: 'card-a-b', detail: cardDetail('card-a-b'), position },
        global: { plugins: [pinia], stubs: { RouterLink: { template: '<a><slot /></a>' } } },
      });
      await flushPromises();
      expect(wrapper.get('[data-testid="card-flow-position"]').text()).toContain(wording);
      expect(wrapper.get('[data-testid="card-flow-technical"]').attributes('open')).toBeUndefined();
      wrapper.unmount();
    }
  });

  it('keeps an exact retained session inspectable with honest unavailable card flow (F11)', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    api.getAgentSession.mockResolvedValue({ session: agentSession('agent:executor:card-zzz') });
    const { OperatorApiError } = await import('../../api/client');
    api.getCard.mockRejectedValue(new OperatorApiError('cards.get', 404, { error: 'Card not found', cardId: 'card-zzz' }));
    const router = createOperatorRouter(createMemoryHistory());
    await router.push('/agents/agent:executor:card-zzz');
    await router.isReady();
    const wrapper = mount(SessionView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();

    expect(wrapper.get('[data-testid="card-flow-id"]').text()).toBe('card-zzz');
    expect(wrapper.get('[data-testid="card-flow-unavailable"]').text()).toBe('Card flow unavailable');
    expect(wrapper.text()).toContain('No hierarchy is inferred');
    expect(wrapper.text()).not.toMatch(/deleted|tombstone|removed/i);
    expect(wrapper.find('[data-testid="back-to-card"]').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('Waiting for conversation');
    wrapper.unmount();
  });

  it('frames a global session with global purpose instead of a card header', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    api.getAgentSession.mockResolvedValue({ session: agentSession('agent:analyst:global', { agent_name: 'analyst' }) });
    const router = createOperatorRouter(createMemoryHistory());
    await router.push('/agents/agent:analyst:global');
    await router.isReady();
    const wrapper = mount(SessionView, { global: { plugins: [pinia, router] } });
    await flushPromises();

    expect(wrapper.get('[data-testid="session-global-header"]').text()).toContain('analyst');
    expect(wrapper.text()).toContain('not owned by a card flow');
    expect(wrapper.find('[data-testid="card-flow-id"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('gates restart confirmation on the exact string with cancel and duplicate-send protection', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const confirmed = vi.fn();
    mount(RestartServerDialog, {
      props: { visible: true, sending: false, error: null },
      global: { plugins: [pinia] },
      listeners: { confirmed },
      attachTo: document.body,
    });
    await flushPromises();

    const input = document.querySelector('[data-testid="restart-confirmation-input"]') as HTMLInputElement;
    const submit = document.querySelector('[data-testid="restart-confirmation-submit"]') as HTMLButtonElement;
    const cancel = document.querySelector('[data-testid="restart-confirmation-cancel"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    input.value = 'RESTART serve';
    input.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(submit.disabled).toBe(true);

    input.value = 'RESTART SERVER';
    input.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(submit.disabled).toBe(false);

    cancel.click();
    await flushPromises();
    expect(confirmed).not.toHaveBeenCalled();
    document.body.innerHTML = '';
  });
});
