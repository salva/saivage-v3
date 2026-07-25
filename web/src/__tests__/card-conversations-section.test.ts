import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../api/types';
import CardConversationsSection from '../components/cards/CardConversationsSection.vue';
import componentSource from '../components/cards/CardConversationsSection.vue?raw';

const api = vi.hoisted(() => ({ getCardAgentSessions: vi.fn(), listAgentSessions: vi.fn() }));
const live = vi.hoisted(() => ({
  openCardAgentSessions: vi.fn(),
  closes: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock('../stores/liveSync', () => ({ useLiveSyncStore: () => live }));
vi.mock('../api/client', () => ({
  getCardAgentSessions: api.getCardAgentSessions,
  listAgentSessions: api.listAgentSessions,
  ApiError: class extends Error {
    status = 500;
    get isUnauthorized() {
      return false;
    }
    get isNotFound() {
      return false;
    }
  },
}));

function session(id: AgentSession['id'], cardId: string): AgentSession {
  return {
    id,
    agent_name: 'executor',
    session_scope: 'card',
    card_id: cardId,
    started_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('CardConversationsSection card-scoped ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    live.closes = [];
    live.openCardAgentSessions.mockImplementation(
      (_cardId: string, callback: (frame: unknown) => Promise<void>) => {
        const close = vi.fn();
        live.closes.push(close);
        void callback(null);
        return close;
      },
    );
    api.getCardAgentSessions.mockImplementation(async (cardId: string) => ({
      card_id: cardId,
      sessions:
        cardId === 'card-a'
          ? [session('agent:executor:card-a', cardId)]
          : [session('agent:executor:card-b', cardId)],
    }));
  });

  it('subscribes before scoped REST, switches exact ownership, and never reads global inventory', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/agents/:id', name: 'agent-detail', component: { template: '<div />' } },
      ],
    });
    await router.push('/');
    const wrapper = mount(CardConversationsSection, {
      props: { cardId: 'card-a' },
      global: { plugins: [pinia, router] },
    });
    await flushPromises();
    expect(live.openCardAgentSessions).toHaveBeenCalledWith('card-a', expect.any(Function));
    expect(api.getCardAgentSessions).toHaveBeenCalledWith('card-a', expect.any(AbortSignal));
    expect(wrapper.text()).toContain('executor');
    expect(api.listAgentSessions).not.toHaveBeenCalled();

    await wrapper.setProps({ cardId: 'card-b' });
    await flushPromises();
    expect(live.closes[0]).toHaveBeenCalledTimes(1);
    expect(live.openCardAgentSessions).toHaveBeenLastCalledWith('card-b', expect.any(Function));
    expect(api.getCardAgentSessions).toHaveBeenLastCalledWith('card-b', expect.any(AbortSignal));
    expect(api.listAgentSessions).not.toHaveBeenCalled();

    wrapper.unmount();
    expect(live.closes[1]).toHaveBeenCalledTimes(1);
  });

  it('contains no global Agent store or endpoint dependency', () => {
    expect(componentSource).not.toContain('useAgentStore');
    expect(componentSource).not.toContain('/api/agents');
  });
});
