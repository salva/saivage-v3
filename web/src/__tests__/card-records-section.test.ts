import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import CardRecordsSection from '../components/cards/CardRecordsSection.vue';
import { useCardStore } from '../stores/cards';
import { cardView } from './card-view-fixtures';

vi.mock('../api/client', () => ({
  getCardRecord: vi.fn(), listCardRecords: vi.fn(), getCardChildren: vi.fn(), getCard: vi.fn(), listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  ApiError: class extends Error { status = 500; body = {}; get isUnauthorized() { return false; } get isNotFound() { return false; } },
}));
import { getCardRecord } from '../api/client';

describe('CardRecordsSection', () => {
  it('keeps accepted content mounted with an exact Retry affordance', async () => {
    setActivePinia(createPinia());
    vi.mocked(getCardRecord).mockResolvedValue({ card_id: 'card-a', record: { name: 'brief.md', content: 'accepted brief', version: 2, committed_at: '2026-07-18T00:00:00Z' } });
    const store = useCardStore();
    const descriptor = { name: 'brief.md', format: 'markdown' as const, schema: 'brief.v1', writers: ['analyst'], bootstrap: true };
    store.selectedCardId = 'card-a';
    store.selectedDetail = { cardId: 'card-a', card: cardView('card-a') };
    store.recordDescriptors = [descriptor];
    store.cardRecords = { 'brief.md': { name: 'brief.md', descriptor, loading: false, error: null, accepted: null, refreshing: false, stale: false, staleReason: null, refreshError: null } };
    const wrapper = mount(CardRecordsSection, { props: { cardId: 'card-a' } });
    await Promise.resolve(); await Promise.resolve();
    store.cardRecords['brief.md'] = { ...store.cardRecords['brief.md']!, stale: true, staleReason: 'refresh-failed', refreshError: 'brief refresh failed' };
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('accepted brief');
    expect(wrapper.text()).toContain('brief refresh failed');
    expect(wrapper.get('button').text()).toBe('Retry');
  });
});
