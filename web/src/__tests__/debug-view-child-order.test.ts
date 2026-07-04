import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DebugView from '../views/DebugView.vue';
import { useCardStore } from '../stores/cards';
import { useDebugStore } from '../stores/debug';
import type { CardRecord } from '../api/types';

vi.mock('../api/client', () => ({ getDebugState: vi.fn(async () => ({ runtime: null, cards: [{ id: 'debug-parent', type: 'goal', parent: null, status: 'running', title: 'Debug Parent', priority: 1, depends_on: [], position: 0 }], totalCards: 1 })), getDebugErrors: vi.fn(async () => ({ errors: [], total: 0 })), getDebugTimeline: vi.fn(async () => ({ events: [], total: 0 })), getDoctor: vi.fn(async () => ({ status: 'ok', checks: [], issues: [] })), getDebugSupervision: vi.fn(async () => ({ reviews: [], quarantine: [], stats: { total: 0, blocked: 0, passed: 0, sanitized: 0, byRisk: {}, bySourceKind: {} } })), listProcesses: vi.fn(async () => ({ processes: [] })), getMcpTools: vi.fn(async () => ({ tools: [], servers: [], invocationStats: {}, serverDetails: [] })), ApiError: class extends Error { status = 500; body = {}; get isUnauthorized() { return false; } } }));
function card(overrides: Partial<CardRecord>): CardRecord { const lifecycle = overrides.lifecycle ?? { status: overrides.status ?? 'running', result: null, error: null, completed_at: null } as CardRecord['lifecycle']; return { id: 'card', type: 'goal', parent: null, position: 0, depth: 0, title: 'Card', status: 'running', tags: [], priority: 1, urgency: 'normal', created_by: 'user', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], related: [], retries: 0, ...overrides, display_path: overrides.display_path ?? null, lifecycle, operator_summary: overrides.operator_summary ?? { lifecycleStatus: lifecycle.status, terminal: false, needsVerification: lifecycle.status === 'needs_verification', blocked: lifecycle.status === 'blocked', hasError: Boolean(lifecycle.error), error: lifecycle.error ?? null, completedAt: lifecycle.completed_at ?? null, stale: lifecycle.status === 'changed', actionCount: 0 } }; }

describe('scenario-debug-view-child-order', () => {
  it('step-1', async () => {
    setActivePinia(createPinia());
    const debugStore = useDebugStore();
    const cardsStore = useCardStore();
    await debugStore.fetchState();
    cardsStore.cards = [card({ id: 'c-e', parent: 'debug-parent', position: 3, title: 'E' }), card({ id: 'c-b', parent: 'debug-parent', position: 1, title: 'B' }), card({ id: 'c-d', parent: 'debug-parent', position: undefined, title: 'D' }), card({ id: 'c-a', parent: 'debug-parent', position: 1, title: 'A' }), card({ id: 'c-c', parent: 'debug-parent', position: 2, title: 'C' })];
    const wrapper = mount(DebugView, { global: { stubs: { CodeBlock: true } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="debug-card-children-list"] [data-testid="debug-card-children-item"] .title').map((n) => n.text())).toEqual(['A', 'B', 'C', 'E', 'D']);
  });
});
