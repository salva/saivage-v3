import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import CardRecordsSection from '../components/cards/CardRecordsSection.vue';
import { useCardStore } from '../stores/cards';

vi.mock('../api/client', () => ({
  getFileContent: vi.fn(), getCardChildren: vi.fn(), getCard: vi.fn(), listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  ApiError: class extends Error { status = 500; body = {}; get isUnauthorized() { return false; } get isNotFound() { return false; } },
}));
import { getFileContent } from '../api/client';

describe('CardRecordsSection', () => {
  it('keeps accepted content mounted with an exact Retry affordance', async () => {
    setActivePinia(createPinia());
    vi.mocked(getFileContent).mockResolvedValue({ path: '', size: 1, contentType: 'text/markdown', content: 'accepted brief', redacted: false, sensitivity: 'normal', version: 2, modifiedAt: '2026-07-18T00:00:00Z' });
    const wrapper = mount(CardRecordsSection, { props: { cardId: 'card-a' } });
    await Promise.resolve(); await Promise.resolve();
    const store = useCardStore();
    store.cardRecords.brief = { ...store.cardRecords.brief, stale: true, staleReason: 'refresh-failed', refreshError: 'brief refresh failed' };
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('accepted brief');
    expect(wrapper.text()).toContain('brief refresh failed');
    expect(wrapper.get('button').text()).toBe('Retry');
  });
});
