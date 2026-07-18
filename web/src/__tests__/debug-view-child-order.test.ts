import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import DebugView from '../views/DebugView.vue';
import { useCardStore } from '../stores/cards';
import { useRuntimeStore } from '../stores/runtime';
import { cardView } from './card-view-fixtures';

vi.mock('../api/client', () => ({ getRuntimeState: vi.fn(async () => ({ runtime: { status: 'running', pid: 42, started_at: '2026-01-01T00:00:00Z', current_card_id: null, current_agent_session_id: null }, projectRoot: '/project', projectId: 'project', cardIndex: { total: 1, byStatus: { running: 1 }, byType: { goal: 1 } }, serverAvailability: null })), getRuntimeStatus: vi.fn(async () => ({ restart_server_available: false })), getDebugErrors: vi.fn(async () => ({ errors: [], total: 0 })), getDebugTimeline: vi.fn(async () => ({ events: [], total: 0 })), getDoctor: vi.fn(async () => ({ status: 'ok', checks: [], issues: [] })), getDebugSupervision: vi.fn(async () => ({ reviews: [], stats: { total: 0, blocked: 0, passed: 0, sanitized: 0, byRisk: {}, bySourceKind: {} } })), listProcesses: vi.fn(async () => ({ processes: [] })), getMcpTools: vi.fn(async () => ({ tools: [], servers: [], invocationStats: {}, serverDetails: [] })), ApiError: class extends Error { status = 500; body = {}; get isUnauthorized() { return false; } } }));

describe('DebugView committed child order', () => {
  it('renders linked children in the parent children order', async () => {
    setActivePinia(createPinia());
    const cardsStore = useCardStore();
    const runtimeStore = useRuntimeStore();
    const router = createRouter({ history: createWebHistory(), routes: [{ path: '/debug', name: 'debug', component: DebugView }] });
    await router.push('/debug');
    await router.isReady();
    const orderedIds = [
      'card-eeeeeeeeeeeeeeeeeeeeeeeeeeee',
      'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'card-dddddddddddddddddddddddddddd',
      'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'card-cccccccccccccccccccccccccccc',
    ];
    cardsStore.cards = [
      cardView(orderedIds[3], { title: 'A' }),
      cardView(orderedIds[2], { title: 'D' }),
      cardView('project', { children: orderedIds, title: 'Debug Parent', status: 'running' }),
      cardView(orderedIds[4], { title: 'C' }),
      cardView(orderedIds[0], { title: 'E' }),
      cardView(orderedIds[1], { title: 'B' }),
    ];
    cardsStore.total = cardsStore.cards.length;
    await runtimeStore.fetchState();
    const wrapper = mount(DebugView, { global: { plugins: [router], stubs: { CodeBlock: true } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="debug-card-children-list"] [data-testid="debug-card-children-item"] .title').map((n) => n.text())).toEqual(['E', 'B', 'D', 'A', 'C']);
    expect(wrapper.find('[data-testid="debug-runtime-state"]').text()).toContain('running');
    expect(wrapper.text()).toContain('Debug Parent');
  });
});
