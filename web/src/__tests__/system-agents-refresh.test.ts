import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import SystemView from '../views/SystemView.vue';
import { getAgentSession, listAgentSessions } from '../api/client';
import { useAgentStore } from '../stores/agents';

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  listAgentSessions: vi.fn(),
  getAgentSession: vi.fn(),
}));
vi.mock('../stores/sync', () => ({
  useSyncStore: () => ({ openAgents: vi.fn(() => () => {}) }),
}));

describe('System participant refresh event boundary', () => {
  it('retains explicit Oversight selection when an Analyst membership hint updates the global partition', async () => {
    const pinia = createPinia();
    const store = useAgentStore(pinia);
    const analyst = {
      id: 'agent:analyst:global' as const, agent_name: 'analyst', session_scope: 'global' as const,
      card_id: null, compaction: null, started_at: '2026-10-01T00:00:00.000Z',
      status: 'inactive' as const, activity: 'idle' as const,
    };
    const oversight = { ...analyst, id: 'agent:oversight:global' as const, agent_name: 'oversight' };
    vi.mocked(listAgentSessions).mockResolvedValueOnce({ sessions: [analyst, oversight] });
    await store.fetchSessions();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/system', name: 'system', component: SystemView }] });
    await router.push('/system?section=participants');
    await router.isReady();
    const wrapper = mount(SystemView, { global: {
      plugins: [pinia, router],
      stubs: { AgentsPanel: {
        props: ['effectiveAgentSessionId'],
        template: '<div><button @click="$emit(\'select-session\', \'agent:oversight:global\')">Oversight</button><p>{{ effectiveAgentSessionId }}</p></div>',
      } },
    } });
    await wrapper.get('.system-content button').trigger('click');
    vi.mocked(getAgentSession).mockResolvedValueOnce({ session: { ...analyst, started_at: '2026-10-01T01:00:00.000Z' } });
    await store.reconcileMembership({ t: 'invalidate', resource: 'agent-membership', scope: 'global-session', session_id: analyst.id });
    await flushPromises();
    expect(wrapper.get('.system-content p').text()).toBe(oversight.id);
    expect(store.sessions).toContainEqual(oversight);
    wrapper.unmount();
  });

  it.each([false, true])('retains store-owned failure feedback (baseline loaded: %s)', async (loaded) => {
    const pinia = createPinia();
    const store = useAgentStore(pinia);
    const analyst = {
      id: 'agent:analyst:global' as const, agent_name: 'analyst', session_scope: 'global' as const,
      card_id: null, compaction: null, started_at: '2026-10-01T00:00:00.000Z',
      status: 'inactive' as const, activity: 'idle' as const,
    };
    if (loaded) {
      vi.mocked(listAgentSessions).mockResolvedValueOnce({ sessions: [analyst] });
      await store.fetchSessions();
    }
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/system', name: 'system', component: SystemView }] });
    await router.push('/system?section=participants');
    await router.isReady();
    const wrapper = mount(SystemView, {
      global: {
        plugins: [pinia, router],
        stubs: { AgentsPanel: {
          props: ['sessionsError', 'sessionsRefreshError', 'effectiveAgentSessionId'],
          template: '<div><button @click="$emit(\'refresh\')">Refresh</button><p>{{ sessionsError || sessionsRefreshError }}</p><p>{{ effectiveAgentSessionId }}</p></div>',
        } },
      },
    });
    vi.mocked(listAgentSessions).mockRejectedValueOnce(new Error('inventory read failed'));
    await wrapper.get('.system-content button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('inventory read failed');
    expect(loaded ? store.sessionsRefreshError : store.sessionsError).toBe('inventory read failed');
    expect(store.sessions).toEqual(loaded ? [analyst] : []);
    expect(store.sessionsLoading).toBe(false);
    expect(store.sessionsRefreshing).toBe(false);
    if (loaded) expect(wrapper.text()).toContain(analyst.id);
    wrapper.unmount();
  });
});
