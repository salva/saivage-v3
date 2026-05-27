import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DashboardView from '../views/DashboardView.vue';
import { useCardStore } from '../stores/cards';
import type { CardRecord } from '../api/types';
vi.mock('../api/client', () => ({ getRuntimeState: vi.fn(async () => ({ runtime: null, projectRoot: '.', projectId: 'fixture', cardIndex: { total: 0, byStatus: {}, byType: {} } })), ApiError: class extends Error { get isUnauthorized() { return false; } } }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function card(overrides: Partial<CardRecord>): CardRecord {
  return { id: 'card', type: 'goal', parent: null, position: 0, depth: 0, title: 'Card', description: '', status: 'active', tags: [], priority: 1, urgency: 'normal', created_by: 'user', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, ...overrides };
}

describe('scenario-dashboard-child-order', () => {
  it('step-1', async () => {
    setActivePinia(createPinia());
    const cardsStore = useCardStore();
    const parent = card({ id: 'goal-a', title: 'Goal A' });
    cardsStore.cards = [parent, card({ id: 'c-e', parent: 'goal-a', position: 3, title: 'E' }), card({ id: 'c-b', parent: 'goal-a', position: 1, title: 'B' }), card({ id: 'c-d', parent: 'goal-a', position: undefined, title: 'D' }), card({ id: 'c-a', parent: 'goal-a', position: 1, title: 'A' }), card({ id: 'c-c', parent: 'goal-a', position: 2, title: 'C' })];
    cardsStore.currentCard = parent;
    const wrapper = mount(DashboardView, { global: { stubs: { MarkdownText: true } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="child-of-goal-list"] [data-testid="child-of-goal-item"] .title').map((n) => n.text())).toEqual(['A', 'B', 'C', 'E', 'D']);
  });
});
