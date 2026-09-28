import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import CockpitView from '../../views/CockpitView.vue';
import ParticipantRail from '../../components/cockpit/ParticipantRail.vue';
import { createOperatorRouter } from '../../router';
import { useCardStore } from '../../stores/cards';
import { useCardAgentSessionsStore } from '../../stores/cardAgentSessions';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';
import { OperatorApiError } from '../../api/client';
import { agentSession, cardDetail, hierarchyParent, hierarchyRecord } from './fixtures';

const api = vi.hoisted(() => ({
  getAgentSession: vi.fn(),
  getCard: vi.fn(),
  getCardChildren: vi.fn(),
  getCardAgentSessions: vi.fn(),
  getDebugGraphs: vi.fn(),
  listCardRecords: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  getAgentSession: api.getAgentSession,
  getCard: api.getCard,
  getCardChildren: api.getCardChildren,
  getCardAgentSessions: api.getCardAgentSessions,
  getDebugGraphs: api.getDebugGraphs,
  listCardRecords: api.listCardRecords,
}));

vi.mock('../../stores/sync', () => ({
  useSyncStore: () => ({
    connectionState: 'connected',
    openCardAgentSessions: (_id: string, callback: () => Promise<void>) => {
      void callback();
      return () => {};
    },
  }),
}));

const entryId = '11111111-1111-4111-8111-111111111111';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

function installDefaults(): void {
  api.getAgentSession.mockImplementation(async (id: string) => ({ session: agentSession(id) }));
  api.getCard.mockImplementation(async (id: string) => ({ card: cardDetail(id, { title: `Title ${id}` }) }));
  api.getCardChildren.mockImplementation(async (id: string) => {
    if (id === 'project') return {
      parent: hierarchyParent('project', { title: 'Project' }),
      children: [hierarchyRecord('card-a', { title: 'Card A' }), hierarchyRecord('card-b', { title: 'Card B' })],
    };
    return { parent: hierarchyParent(id), children: [] };
  });
  api.getCardAgentSessions.mockResolvedValue({ sessions: [] });
  api.getDebugGraphs.mockResolvedValue({ graphs: [], global_agents: [] });
  api.listCardRecords.mockImplementation(async (cardId: string) => ({
    card_id: cardId,
    records: [{ name: 'brief.md', format: 'markdown', schema: 'card-brief.v1', bootstrap: true, current: null }],
  }));
}

async function mountRoute(path: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createOperatorRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  useWorkspaceRouteStore(pinia).registerRouterListener(router);
  await useCardStore(pinia).ensureRoot();
  const wrapper = mount(CockpitView, {
    global: {
      plugins: [pinia, router],
      stubs: {
        AgentConversationView: {
          props: ['sessionId', 'entryId'],
          template: '<div data-testid="exact-reader" :data-session="sessionId" :data-entry="entryId" />',
        },
      },
    },
  });
  await settle();
  return { wrapper, router, pinia };
}

describe('shared cockpit conversation navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installDefaults();
  });

  it('renders a direct exact card session in the shared cockpit with four tabs and one entry-preserving reader', async () => {
    const sessionId = 'agent:reviewer:card-a';
    api.getCardAgentSessions.mockResolvedValue({ sessions: [agentSession(sessionId)] });
    const { wrapper, router } = await mountRoute(`/agents/${sessionId}?entry=${entryId}`);

    expect(router.currentRoute.value.fullPath).toBe(`/agents/${sessionId}?entry=${entryId}`);
    expect(wrapper.findAll('[data-testid="route-cockpit"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="cockpit-facet-nav"]').text()).toContain('Overview');
    expect(wrapper.get('[data-testid="cockpit-facet-nav"]').text()).toContain('Records & History');
    expect(wrapper.findAll('.cockpit-facet-link')).toHaveLength(4);
    expect(wrapper.get('.cockpit-facet-link.active').text()).toBe('Conversations');
    expect(wrapper.findAll('[data-testid="exact-reader"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="exact-reader"]').attributes()).toMatchObject({
      'data-session': sessionId,
      'data-entry': entryId,
    });
    wrapper.unmount();
  });

  it('does not auto-replace an explicitly addressed inactive session', async () => {
    const selected = 'agent:reviewer:card-a';
    api.getCardAgentSessions.mockResolvedValue({ sessions: [
      agentSession('agent:executor:card-a', { status: 'active', activity: 'busy' }),
      agentSession(selected),
    ] });
    const { wrapper, router } = await mountRoute(`/agents/${selected}`);
    await settle();

    expect(router.currentRoute.value.fullPath).toBe(`/agents/${selected}`);
    expect(wrapper.get('[data-testid="exact-reader"]').attributes('data-session')).toBe(selected);
    wrapper.unmount();
  });

  it('rejects malformed and missing exact sessions without card lookup or replacement search', async () => {
    const malformed = await mountRoute('/agents/not-an-agent');
    expect(malformed.wrapper.find('[data-testid="session-invalid"]').exists()).toBe(true);
    expect(api.getAgentSession).not.toHaveBeenCalled();
    expect(api.getCard).not.toHaveBeenCalled();
    malformed.wrapper.unmount();

    vi.clearAllMocks();
    installDefaults();
    api.getAgentSession.mockRejectedValue(new OperatorApiError('agents.detail', 404, { error: 'Agent session not found' }));
    const missing = await mountRoute('/agents/agent:executor:card-a');
    expect(missing.wrapper.text()).toContain('No replacement is searched');
    expect(api.getAgentSession).toHaveBeenCalledTimes(1);
    expect(api.getCard).not.toHaveBeenCalled();
    expect(api.getCardAgentSessions).not.toHaveBeenCalled();
    missing.wrapper.unmount();
  });

  it('fences late scope and card completions after a newer exact route wins', async () => {
    const scopeA = deferred<{ session: ReturnType<typeof agentSession> }>();
    const cardA = deferred<{ card: ReturnType<typeof cardDetail> }>();
    api.getAgentSession.mockImplementation((id: string) => id.endsWith('card-a')
      ? scopeA.promise
      : Promise.resolve({ session: agentSession(id) }));
    api.getCard.mockImplementation((id: string) => id === 'card-a'
      ? cardA.promise
      : Promise.resolve({ card: cardDetail(id, { title: 'Newer Card B' }) }));
    const { wrapper, router } = await mountRoute('/agents/agent:executor:card-a');
    await router.push('/agents/agent:executor:card-b');
    await settle();
    expect(wrapper.get('[data-testid="card-flow-id"]').text()).toBe('card-b');

    scopeA.resolve({ session: agentSession('agent:executor:card-a') });
    await settle();
    expect(router.currentRoute.value.params.id).toBe('agent:executor:card-b');
    expect(wrapper.get('[data-testid="card-flow-id"]').text()).toBe('card-b');

    api.getAgentSession.mockImplementation(async (id: string) => ({ session: agentSession(id) }));
    await router.push('/agents/agent:executor:card-a');
    await settle();
    expect(api.getCard).toHaveBeenCalledWith('card-a', expect.any(AbortSignal));
    await router.push('/agents/agent:executor:card-b');
    await settle();
    cardA.resolve({ card: cardDetail('card-a', { title: 'Late Card A' }) });
    await settle();
    expect(router.currentRoute.value.params.id).toBe('agent:executor:card-b');
    expect(wrapper.get('[data-testid="card-flow-id"]').text()).toBe('card-b');
    expect(wrapper.text()).not.toContain('Late Card A');
    wrapper.unmount();
  });

  it('keeps the exact reader with typed retry and disabled tabs on initial non-404 card failure', async () => {
    api.getCard.mockRejectedValue(new Error('card network unavailable'));
    const { wrapper } = await mountRoute('/agents/agent:executor:card-a');

    expect(wrapper.findAll('[data-testid="exact-reader"]')).toHaveLength(1);
    expect(wrapper.text()).toContain('Network error');
    expect(wrapper.text()).toContain('card network unavailable');
    expect(wrapper.findAll('[aria-disabled="true"]')).toHaveLength(3);
    expect(wrapper.findAll('button').some((button) => button.text().includes('Retry'))).toBe(true);
    wrapper.unmount();
  });

  it('retains the exact reader but tears down rail and card-owned presentation after an authoritative 404', async () => {
    api.getCardAgentSessions.mockResolvedValue({ sessions: [agentSession('agent:executor:card-a')] });
    const { wrapper, pinia } = await mountRoute('/agents/agent:executor:card-a');
    expect(wrapper.find('.participant-rail').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="exact-reader"]')).toHaveLength(1);

    api.getCard.mockRejectedValueOnce(new OperatorApiError('cards.get', 404, { error: 'Card not found', cardId: 'card-a' }));
    await useCardStore(pinia).fetchCardDetail('card-a');
    await settle();

    expect(wrapper.findAll('[data-testid="exact-reader"]')).toHaveLength(1);
    expect(wrapper.find('.participant-rail').exists()).toBe(false);
    expect(wrapper.get('[data-testid="card-flow-unavailable"]').text()).toBe('Card flow unavailable');
    expect(wrapper.findAll('[aria-disabled="true"]')).toHaveLength(3);
    wrapper.unmount();
  });
});

describe('ParticipantRail automatic initial selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installDefaults();
    setActivePinia(createPinia());
  });

  function mountRail() {
    return mount(ParticipantRail, {
      props: { cardId: 'card-a', detail: cardDetail('card-a'), selectedSessionId: null },
      global: { plugins: [createPinia()] },
    });
  }

  it.each([
    ['zero active sessions', [agentSession('agent:reviewer:card-a')]],
    ['multiple active sessions', [
      agentSession('agent:executor:card-a', { status: 'active', activity: 'busy' }),
      agentSession('agent:reviewer:card-a', { status: 'active', activity: 'busy' }),
    ]],
  ])('does not auto-select for %s', async (_label, sessions) => {
    api.getCardAgentSessions.mockResolvedValue({ sessions });
    const wrapper = mountRail();
    await settle();
    expect(wrapper.emitted('auto-select')).toBeUndefined();
    wrapper.unmount();
  });

  it('never selects retained stale membership after failure, then selects once after successful Retry', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const sole = agentSession('agent:executor:card-a', { status: 'active', activity: 'busy' });
    api.getCardAgentSessions.mockResolvedValueOnce({ sessions: [sole] });
    await useCardAgentSessionsStore(pinia).fetchScope('card-a');
    api.getCardAgentSessions.mockRejectedValueOnce(new Error('initial observation failed'));
    const wrapper = mount(ParticipantRail, {
      props: { cardId: 'card-a', detail: cardDetail('card-a'), selectedSessionId: null },
      global: { plugins: [pinia] },
    });
    await settle();
    expect(wrapper.emitted('auto-select')).toBeUndefined();
    expect(wrapper.text()).toContain('initial observation failed');

    api.getCardAgentSessions.mockResolvedValueOnce({ sessions: [sole] });
    await wrapper.get('button').trigger('click');
    await settle();
    expect(wrapper.emitted('auto-select')).toEqual([[sole.id]]);

    api.getCardAgentSessions.mockResolvedValueOnce({ sessions: [sole] });
    await useCardAgentSessionsStore(pinia).fetchScope('card-a');
    await settle();
    expect(wrapper.emitted('auto-select')).toEqual([[sole.id]]);
    wrapper.unmount();
  });
});
