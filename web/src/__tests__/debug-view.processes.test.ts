import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import DebugView from '../views/DebugView.vue';
import { listProcesses } from '../api/client';

const mockPush = vi.fn();

vi.mock('../api/client', () => {
  const ApiError = class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  };
  return {
    getDebugState: vi.fn().mockResolvedValue({ runtime: null, cards: [], totalCards: 0 }),
    getDebugErrors: vi.fn().mockResolvedValue({ errors: [], total: 0 }),
    getDebugTimeline: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    getDoctor: vi.fn().mockResolvedValue({ status: 'ok', checks: [], issues: [] }),
    getDebugSupervision: vi.fn().mockResolvedValue({ reviews: [], quarantine: [], stats: null }),
    listProcesses: vi.fn(),
    getMcpTools: vi.fn().mockResolvedValue({ tools: [], stats: {} }),
    ApiError,
  };
});

vi.mock('../stores/liveSync', () => ({
  useLiveSyncStore: () => ({ registerResource: vi.fn(() => vi.fn()), openConversation: vi.fn(() => vi.fn()) }),
}));

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

async function mountDebugView() {
  setActivePinia(createPinia());
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/files', name: 'files', component: { template: '<div>Files</div>' } }],
  });
  const wrapper = mount(DebugView, { global: { plugins: [createPinia(), router], stubs: { CodeBlock: true } } });
  await flushPromises();
  return wrapper;
}

describe('DebugView processes tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProcesses).mockResolvedValue({
      processes: [{
        id: 'proc-1',
        status: 'running',
        command: 'npm test',
        card_id: 'card-1',
        session_id: 'session-1',
        owner: 'executor',
        owner_id: 'executor-1',
        cwd: '/work/project',
        started_at: '2026-06-12T00:00:00.000Z',
        ended_at: null,
        exit_code: null,
        timed_out: false,
        logs: { stdout: '.saivage-work/tmp/processes/proc-1/stdout.log', stderr: null },
      }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves process inspection and log browsing without termination controls', async () => {
    const wrapper = await mountDebugView();
    const processTab = wrapper.findAll('.debug-tab-button').find((tab) => tab.text() === 'Processes');
    expect(processTab).toBeTruthy();

    await processTab!.trigger('click');
    await flushPromises();

    expect(listProcesses).toHaveBeenCalled();
    expect(wrapper.find('.debug-section-title').text()).toBe('Processes');
    expect(wrapper.text()).toContain('proc-1');
    expect(wrapper.text()).toContain('npm test');
    expect(wrapper.find('.process-link-button').exists()).toBe(true);
    expect(wrapper.findAll('button').map((button) => button.text().toLowerCase())).not.toEqual(expect.arrayContaining(['terminate', 'kill']));

    await wrapper.find('.process-link-button').trigger('click');
    expect(mockPush).toHaveBeenCalledWith({ name: 'files', query: { path: '.saivage-work/tmp/processes/proc-1/stdout.log' } });
  });
});
