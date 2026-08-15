import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import CardRecordsSection from '../components/cards/CardRecordsSection.vue';
import { useCardStore } from '../stores/cards';
import { cardView } from './card-view-fixtures';

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getCardRecord: vi.fn(), listCardRecords: vi.fn(), getCardChildren: vi.fn(), getCard: vi.fn(), listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
}));
import { getCardRecord } from '../api/client';

describe('CardRecordsSection', () => {
  it('keeps accepted content mounted with an exact Retry affordance', async () => {
    setActivePinia(createPinia());
    vi.mocked(getCardRecord).mockResolvedValue({ card_id: 'card-a', record: { name: 'brief.md', head_version:2,head_entry_id:'11111111-1111-4111-8111-111111111111',state:'closed',accepted:{source_version:2,source_entry_id:'11111111-1111-4111-8111-111111111111',committed_at:'2026-07-18T00:00:00Z',writer_agent:'analyst',card_version_seq:1,content:'accepted brief',content_sha256:'a'.repeat(64),size_bytes:14},draft:null,discarded:null,effective_content_source:'accepted' } });
    const store = useCardStore();
    const descriptor = { name: 'brief.md', format: 'markdown' as const, schema: 'brief.v1', bootstrap: true, current:null };
    store.selectedCardId = 'card-a';
    store.selectedDetail = { cardId: 'card-a', card: cardView('card-a') };
    store.recordDescriptors = [descriptor];
    store.cardRecords = { 'brief.md': { name: 'brief.md', descriptor, loading: false, error: null,current:null, accepted: null,history:null,historyLoading:false,historyError:null,selectedVersion:null,selected:null,selectedLoading:false,selectedError:null,diff:null,diffLoading:false,diffError:null,refreshing: false, stale: false, staleReason: null, refreshError: null } };
    const wrapper = mount(CardRecordsSection, { props: { cardId: 'card-a' } });
    await Promise.resolve(); await Promise.resolve();
    store.cardRecords['brief.md'] = { ...store.cardRecords['brief.md']!, stale: true, staleReason: 'refresh-failed', refreshError: 'brief refresh failed' };
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('accepted brief');
    expect(wrapper.text()).toContain('brief refresh failed');
    expect(wrapper.get('button').text()).toBe('Retry');
  });
});
