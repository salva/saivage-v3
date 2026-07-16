import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import DebugView from '../views/DebugView.vue';
import { useCardStore } from '../stores/cards';
import { useRuntimeStore } from '../stores/runtime';
import type { CardRecord } from '../api/types';

vi.mock('../api/client', () => ({ getRuntimeState: vi.fn(async () => ({ runtime: { status: 'running', pid: 42, started_at: '2026-01-01T00:00:00Z', current_card_id: null, current_agent_session_id: null }, projectRoot: '/project', projectId: 'project', cardIndex: { total: 1, byStatus: { running: 1 }, byType: { goal: 1 } }, serverAvailability: null })), getRuntimeStatus: vi.fn(async () => ({ restart_server_available: false })), getDebugErrors: vi.fn(async () => ({ errors: [], total: 0 })), getDebugTimeline: vi.fn(async () => ({ events: [], total: 0 })), getDoctor: vi.fn(async () => ({ status: 'ok', checks: [], issues: [] })), getDebugSupervision: vi.fn(async () => ({ reviews: [], stats: { total: 0, blocked: 0, passed: 0, sanitized: 0, byRisk: {}, bySourceKind: {} } })), listProcesses: vi.fn(async () => ({ processes: [] })), getMcpTools: vi.fn(async () => ({ tools: [], servers: [], invocationStats: {}, serverDetails: [] })), ApiError: class extends Error { status = 500; body = {}; get isUnauthorized() { return false; } } }));
function card(overrides: Partial<CardRecord>): CardRecord { const lifecycle = overrides.lifecycle ?? { status: overrides.status ?? 'running', result: null, error: null, completed_at: null } as CardRecord['lifecycle']; return { id: '11111111-1111-4111-8111-111111111111', type: 'goal', parent: null, position: 0, depth: 0, title: 'Card', status: 'running', tags: [], priority: 1, urgency: 'normal', created_by: 'user', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], related: [], pending_notifications: [], ...overrides, display_path: overrides.display_path ?? null, lifecycle, operator_summary: overrides.operator_summary ?? { lifecycleStatus: lifecycle.status, terminal: false, blocked: lifecycle.status === 'blocked', hasError: Boolean(lifecycle.error), error: lifecycle.error ?? null, completedAt: lifecycle.completed_at ?? null, stale: lifecycle.status === 'changed', actionCount: 0 } }; }

describe('scenario-debug-view-child-order', () => {
  it('step-1', async () => {
    setActivePinia(createPinia());
    const cardsStore = useCardStore();
    const runtimeStore = useRuntimeStore();
    const router = createRouter({ history: createWebHistory(), routes: [{ path: '/debug', name: 'debug', component: DebugView }] });
    await router.push('/debug');
    await router.isReady();
    cardsStore.cards = [card({ title: 'Debug Parent' }), card({ id: '55555555-5555-4555-8555-555555555555', parent: '11111111-1111-4111-8111-111111111111', position: 3, title: 'E' }), card({ id: '22222222-2222-4222-8222-222222222222', parent: '11111111-1111-4111-8111-111111111111', position: 1, title: 'B' }), card({ id: '44444444-4444-4444-8444-444444444444', parent: '11111111-1111-4111-8111-111111111111', position: undefined, title: 'D' }), card({ id: '11111111-1111-4111-8111-111111111112', parent: '11111111-1111-4111-8111-111111111111', position: 1, title: 'A' }), card({ id: '33333333-3333-4333-8333-333333333333', parent: '11111111-1111-4111-8111-111111111111', position: 2, title: 'C' })];
    cardsStore.total = cardsStore.cards.length;
    await runtimeStore.fetchState();
    const wrapper = mount(DebugView, { global: { plugins: [router], stubs: { CodeBlock: true } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="debug-card-children-list"] [data-testid="debug-card-children-item"] .title').map((n) => n.text())).toEqual(['A', 'B', 'C', 'E', 'D']);
    expect(wrapper.find('[data-testid="debug-runtime-state"]').text()).toContain('running');
    expect(wrapper.text()).toContain('Debug Parent');
  });
});
