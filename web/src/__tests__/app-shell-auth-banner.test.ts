import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';

function waitForTransition(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 250));
}
import AppShell from '../components/layout/AppShell.vue';
import { API_AUTH_REQUIRED_EVENT, API_AUTH_DISMISSED_SESSION_KEY } from '../utils/auth-events';

vi.mock('../api/auth', () => ({ getAuthToken: vi.fn(() => null) }));
vi.mock('../api/client', () => ({
  listChatSessions: vi.fn(async () => ({ sessions: [{ id: 'analyst:global', role: 'analyst', status: 'active', started_at: '2026-01-01T00:00:00Z' }] })),
  getChatEntries: vi.fn(async (sessionId: string) => ({ sessionId, entries: [] })),
  sendChatMessage: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));
vi.mock('../stores/sync', () => ({
  useSyncStore: () => ({ connect: vi.fn(), disconnect: vi.fn(), registerResource: vi.fn(() => vi.fn()), connectionState: 'connected' }),
}));
vi.mock('../stores/cards', () => ({ useCardStore: () => ({ refetch: vi.fn(async () => undefined) }) }));
vi.mock('../stores/agents', () => ({ useAgentStore: () => ({ refetch: vi.fn(async () => undefined) }) }));

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: { template: '<div>dashboard</div>' } },
      { path: '/cards', name: 'cards', component: { template: '<div>cards</div>' } },
      { path: '/cards/:id', name: 'card-detail', component: { template: '<div>card</div>' } },
      { path: '/timeline', name: 'timeline', component: { template: '<div>timeline</div>' } },
      { path: '/agents', name: 'agents', component: { template: '<div>agents</div>' } },
      { path: '/files', name: 'files', component: { template: '<div>files</div>' } },
      { path: '/debug', name: 'debug', component: { template: '<div>debug</div>' } },
    ],
  });
}

describe('AppShell API auth banner', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
  });

  it('surfaces 401 auth banner, opens Token modal, and dismissal persists for the session', async () => {
    const router = makeRouter();
    await router.push('/dashboard');
    await router.isReady();
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });

    window.dispatchEvent(new CustomEvent(API_AUTH_REQUIRED_EVENT, { detail: { status: 401, path: '/api/state' } }));
    await flushPromises();

    expect(wrapper.find('[data-testid="api-auth-banner"]').text()).toContain('API token required');
    await wrapper.get('.auth-banner-action').trigger('click');
    expect(wrapper.find('.ui-overlay').exists()).toBe(true);
    expect(wrapper.find('[data-testid="api-auth-banner"]').exists()).toBe(true);

    await wrapper.get('.token-btn-cancel').trigger('click');
    await flushPromises();
    await waitForTransition();
    expect(wrapper.find('.ui-overlay').exists()).toBe(false);
    expect(wrapper.find('[data-testid="api-auth-banner"]').exists()).toBe(true);

    await wrapper.get('.auth-banner-action').trigger('click');
    expect(wrapper.find('.ui-overlay').exists()).toBe(true);

    await wrapper.get('.auth-banner-dismiss').trigger('click');
    expect(wrapper.find('[data-testid="api-auth-banner"]').exists()).toBe(false);
    expect(sessionStorage.getItem(API_AUTH_DISMISSED_SESSION_KEY)).toBe('true');

    window.dispatchEvent(new CustomEvent(API_AUTH_REQUIRED_EVENT, { detail: { status: 401, path: '/api/cards' } }));
    await flushPromises();
    expect(wrapper.find('[data-testid="api-auth-banner"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
