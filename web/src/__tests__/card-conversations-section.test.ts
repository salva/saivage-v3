import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../api/types';
import CardConversationsSection from '../components/cards/CardConversationsSection.vue';
import { useAgentStore } from '../stores/agents';

const api = vi.hoisted(() => ({ listAgentSessions: vi.fn() }));

vi.mock('../api/client', () => ({
  listAgentSessions: api.listAgentSessions,
  getAgentConversation: vi.fn(),
  getAgentLlmExchange: vi.fn(),
  ApiError: class extends Error {
    status = 500;
    get isUnauthorized() { return false; }
  },
}));

function session(id: string, cardId: string): AgentSession {
  return {
    id,
    role: 'executor',
    goal_card_id: cardId,
    card_id: cardId,
    status: 'done',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:01:00.000Z',
    model: id,
  };
}

describe('CardConversationsSection canonical list consumption', () => {
  beforeEach(() => {
    api.listAgentSessions.mockReset();
  });

  it('mounts and changes card ID without reads, reactively filters, and makes one retained-data manual refresh', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentStore();
    store.sessions = [session('session-a', 'card-a'), session('session-b', 'card-b')];
    store.sessionsLoaded = true;
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

    expect(api.listAgentSessions).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('session-a');
    expect(wrapper.text()).not.toContain('session-b');

    await wrapper.setProps({ cardId: 'card-b' });
    expect(api.listAgentSessions).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('session-b');
    expect(wrapper.text()).not.toContain('session-a');

    api.listAgentSessions.mockRejectedValueOnce(new Error('refresh failed'));
    await wrapper.get('.conv-refresh').trigger('click');
    await flushPromises();
    expect(api.listAgentSessions).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('session-b');
    expect(wrapper.text()).toContain('Failed to fetch agent sessions');
  });
});
