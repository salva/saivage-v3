import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import DebugView from '../views/DebugView.vue';
import { useDebugStore } from '../stores/debug';
import { useMcpStore } from '../stores/mcp';
import type { DebugTimelineEvent } from '../api/types';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    getDebugState: vi.fn().mockResolvedValue({ runtime: null, cards: [], totalCards: 0 }),
    getDebugErrors: vi.fn().mockResolvedValue({ errors: [], total: 0 }),
    getDebugTimeline: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    getDoctor: vi.fn().mockResolvedValue(null),
    getDebugSupervision: vi.fn().mockResolvedValue(null),
    listProcesses: vi.fn().mockResolvedValue({ processes: [] }),
    listControlActions: vi.fn().mockResolvedValue({ actions: [] }),
  };
});

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/files', name: 'files', component: { template: '<div />' } },
    ],
  });
}

async function mountDebugView(events: DebugTimelineEvent[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const client = await import('../api/client');
  vi.mocked(client.getDebugTimeline).mockResolvedValue({ events, total: events.length });
  const debugStore = useDebugStore();
  const mcpStore = useMcpStore();
  vi.spyOn(debugStore, 'setupWsListener').mockImplementation(() => {});
  vi.spyOn(mcpStore, 'fetchMcpData').mockResolvedValue(undefined);
  vi.spyOn(mcpStore, 'startPolling').mockImplementation(() => {});
  vi.spyOn(mcpStore, 'stopPolling').mockImplementation(() => {});
  const router = makeRouter();
  await router.push({ path: '/', query: { tab: 'timeline' } });
  await router.isReady();
  const wrapper = mount(DebugView, {
    global: { plugins: [pinia, router] },
  });
  await flushPromises();
  const timelineBtn = wrapper.findAll('button.debug-tab-button').find((b) => b.text() === 'Timeline');
  if (!timelineBtn) throw new Error('Timeline tab button not found');
  await timelineBtn.trigger('click');
  await flushPromises();
  return wrapper;
}

describe('DebugView timeline terminal_tool chip', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('renders terminal_tool chip on llm_attempt events whose outcome carries the field', async () => {
    const wrapper = await mountDebugView([
      {
        id: 'evt-1',
        kind: 'llm_attempt',
        timestamp: '2026-05-23T10:00:00Z',
        session_id: 'sess-1',
        outcome: { kind: 'succeeded', terminal_tool: 'emit_planner_result' },
      } as unknown as DebugTimelineEvent,
    ]);
    const chips = wrapper.findAll('.tl-event-terminal-tool');
    expect(chips).toHaveLength(1);
    expect(chips[0].text()).toBe('emit_planner_result');
  });

  it('omits the chip on events without terminal_tool', async () => {
    const wrapper = await mountDebugView([
      {
        id: 'evt-2',
        kind: 'llm_attempt',
        timestamp: '2026-05-23T10:00:00Z',
        session_id: 'sess-1',
        outcome: { kind: 'failed', failure_class: 'unknown', recovery_action: 'abort_without_retry', error_name: 'E', error_message: 'x', error_preview: 'x' },
      } as unknown as DebugTimelineEvent,
    ]);
    expect(wrapper.find('.tl-event-terminal-tool').exists()).toBe(false);
  });
});
