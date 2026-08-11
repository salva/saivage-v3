import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import DebugView from '../views/DebugView.vue';

const api = vi.hoisted(() => ({
  getMcpTools: vi.fn(), getNewestEvents: vi.fn(), getDebugErrors: vi.fn(),
  listProcesses: vi.fn(), listAgentSessions: vi.fn(), getDebugGraphs: vi.fn(), getDoctor: vi.fn(),
}));
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  ...api,
}));
const live = vi.hoisted(() => ({ openAgents: vi.fn(() => vi.fn()) }));
vi.mock('../stores/sync', () => ({ useSyncStore: () => live }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function mountDebug(path: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/debug', name: 'debug', component: DebugView },
      { path: '/files', name: 'files', component: { template: '<div />' } },
    ],
  });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(DebugView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper;
}

describe('Debug selected-tab ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getMcpTools.mockResolvedValue({ servers: [] });
    api.getNewestEvents.mockResolvedValue({ events: [], total: 0 });
    api.getDebugErrors.mockResolvedValue({ errors: [], total: 0 });
    api.listProcesses.mockResolvedValue({ processes: [] });
    api.listAgentSessions.mockResolvedValue({ sessions: [] });
    api.getDebugGraphs.mockResolvedValue({ graphs: [] });
    api.getDoctor.mockResolvedValue({ status: 'ok', checks: [{ name: 'cards_loadable', passed: true, details: 'Cards loaded successfully.' }], issues: [] });
  });

  it('loads only MCP when MCP is selected and never polls', async () => {
    const wrapper = await mountDebug('/debug?tab=mcp');
    expect(api.getMcpTools).toHaveBeenCalledTimes(1);
    expect(api.getNewestEvents).not.toHaveBeenCalled();
    expect(api.getDebugErrors).not.toHaveBeenCalled();
    expect(api.listAgentSessions).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.getMcpTools).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('loads no Agent, event, or MCP resource for the default State tab', async () => {
    const wrapper = await mountDebug('/debug');
    expect(api.listAgentSessions).not.toHaveBeenCalled();
    expect(api.getNewestEvents).not.toHaveBeenCalled();
    expect(api.getMcpTools).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps Doctor manual even while selected', async () => {
    const wrapper = await mountDebug('/debug?tab=doctor');
    expect(api.getDoctor).not.toHaveBeenCalled();
    await wrapper.get('button.sv-fetch-btn').trigger('click');
    await flushPromises();
    expect(api.getDoctor).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('presents only the selected Errors or Timeline request state', async () => {
    const errorsRequest = deferred<{ errors: []; total: 0 }>();
    const timelineRequest = deferred<{ events: []; total: 0 }>();
    api.getDebugErrors.mockReturnValue(errorsRequest.promise);
    api.getNewestEvents.mockReturnValue(timelineRequest.promise);
    const wrapper = await mountDebug('/debug?tab=errors');
    const tabButton = (label: string) =>
      wrapper.findAll('button.debug-tab-button').find((button) => button.text() === label)!;

    expect(api.getDebugErrors).toHaveBeenCalledTimes(1);
    expect(api.getNewestEvents).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Loading errors...');
    expect(wrapper.text()).not.toContain('Loading timeline...');
    expect(wrapper.text()).not.toContain('Failed to fetch debug timeline');

    await tabButton('Timeline').trigger('click');
    await flushPromises();

    expect(api.getDebugErrors).toHaveBeenCalledTimes(1);
    expect(api.getNewestEvents).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('Loading timeline...');
    expect(wrapper.text()).not.toContain('Loading errors...');
    expect(wrapper.text()).not.toContain('Failed to fetch debug errors');

    errorsRequest.reject(new Error('errors unavailable'));
    await flushPromises();

    expect(wrapper.text()).toContain('Loading timeline...');
    expect(wrapper.text()).not.toContain('Failed to fetch debug errors');

    timelineRequest.reject(new Error('timeline unavailable'));
    await flushPromises();

    expect(wrapper.text()).toContain('Failed to fetch debug timeline');
    expect(wrapper.text()).not.toContain('Failed to fetch debug errors');

    await tabButton('Errors').trigger('click');
    await flushPromises();

    expect(api.getDebugErrors).toHaveBeenCalledTimes(2);
    expect(api.getNewestEvents).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('Failed to fetch debug errors');
    expect(wrapper.text()).not.toContain('Failed to fetch debug timeline');
    wrapper.unmount();
  });
});
