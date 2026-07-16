import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import FilesView from '../views/FilesView.vue';
import { useCardStore } from '../stores/cards';
import type { CardRecord } from '../api/types';

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push: vi.fn() }) }));
function card(overrides: Partial<CardRecord>): CardRecord { const lifecycle = overrides.lifecycle ?? { status: overrides.status ?? 'running', result: null, error: null, completed_at: null } as CardRecord['lifecycle']; return { id: '11111111-1111-4111-8111-111111111111', type: 'goal', parent: null, position: 0, depth: 0, title: 'Card', status: 'running', tags: [], priority: 1, urgency: 'normal', created_by: 'user', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], related: [], pending_notifications: [], ...overrides, display_path: overrides.display_path ?? null, lifecycle, operator_summary: overrides.operator_summary ?? { lifecycleStatus: lifecycle.status, terminal: false, blocked: lifecycle.status === 'blocked', hasError: Boolean(lifecycle.error), error: lifecycle.error ?? null, completedAt: lifecycle.completed_at ?? null, stale: lifecycle.status === 'changed', actionCount: 0 } }; }

describe('scenario-files-view-child-order', () => {
  it('step-1', async () => {
    setActivePinia(createPinia());
    const cardsStore = useCardStore();
    const parent = card({ id: '66666666-6666-4666-8666-666666666666', title: 'Parent A' });
    cardsStore.cards = [parent, card({ id: '55555555-5555-4555-8555-555555555555', parent: parent.id, position: 3, title: 'E' }), card({ id: '22222222-2222-4222-8222-222222222222', parent: parent.id, position: 1, title: 'B' }), card({ id: '44444444-4444-4444-8444-444444444444', parent: parent.id, position: undefined, title: 'D' }), card({ id: '11111111-1111-4111-8111-111111111111', parent: parent.id, position: 1, title: 'A' }), card({ id: '33333333-3333-4333-8333-333333333333', parent: parent.id, position: 2, title: 'C' })];
    cardsStore.currentCard = parent;
    const wrapper = mount(FilesView, { global: { stubs: { CodeBlock: true, MarkdownText: true } } });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="files-card-children-list"] [data-testid="files-card-children-item"] .title').map((n) => n.text())).toEqual(['A', 'B', 'C', 'E', 'D']);
  });
});
