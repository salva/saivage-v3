import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import FilesView from '../views/FilesView.vue';
import { useCardStore } from '../stores/cards';
import type { CardRecord } from '../api/types';

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push: vi.fn() }) }));
function card(overrides: Partial<CardRecord>): CardRecord { const lifecycle = overrides.lifecycle ?? { status: overrides.status ?? 'running', result: null, error: null, completed_at: null } as CardRecord['lifecycle']; return { id: 'card', type: 'goal', parent: null, position: 0, depth: 0, title: 'Card', description: '', status: 'running', tags: [], priority: 1, urgency: 'normal', created_by: 'user', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, ...overrides, display_path: overrides.display_path ?? null, lifecycle, operator_summary: overrides.operator_summary ?? { lifecycleStatus: lifecycle.status, terminal: false, needsVerification: lifecycle.status === 'needs_verification', blocked: lifecycle.status === 'blocked', hasError: Boolean(lifecycle.error), error: lifecycle.error ?? null, completedAt: lifecycle.completed_at ?? null, stale: lifecycle.status === 'changed', actionCount: 0 } }; }

describe('scenario-files-view-child-order', () => {
  it('step-1', async () => {
    setActivePinia(createPinia());
    const cardsStore = useCardStore();
    const parent = card({ id: 'parent-a', title: 'Parent A' });
    cardsStore.cards = [parent, card({ id: 'c-e', parent: 'parent-a', position: 3, title: 'E' }), card({ id: 'c-b', parent: 'parent-a', position: 1, title: 'B' }), card({ id: 'c-d', parent: 'parent-a', position: undefined, title: 'D' }), card({ id: 'c-a', parent: 'parent-a', position: 1, title: 'A' }), card({ id: 'c-c', parent: 'parent-a', position: 2, title: 'C' })];
    cardsStore.currentCard = parent;
    const wrapper = mount(FilesView, { global: { stubs: { CodeBlock: true, MarkdownText: true } } });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="files-card-children-list"] [data-testid="files-card-children-item"] .title').map((n) => n.text())).toEqual(['A', 'B', 'C', 'E', 'D']);
  });
});
