import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import CardDetailView from '../components/cards/CardDetailView.vue';
import { useCardStore } from '../stores/cards';
import { cardView } from './card-view-fixtures';
import detailSource from '../components/cards/CardDetailView.vue?raw';
import recordsSource from '../components/cards/CardRecordsSection.vue?raw';

describe('CardDetailView S06 read-only detail contract', () => {
  it('retains detail retry and separate record-output affordances', () => {
    expect(detailSource).toContain('reloadDetail');
    expect(detailSource).not.toContain('dispatch.targetCardId');
    expect(detailSource).not.toContain('dispatch.parentCardId');
  });

  it('renders route-bound loading and failure from selected-detail state only', () => {
    expect(detailSource).toContain('v-if="routeLoading"');
    expect(detailSource).toContain('v-else-if="detailError && !currentCard"');
    expect(detailSource).toContain('selectedDetailFreshness.stale');
    expect(detailSource).not.toMatch(/\bloading,\s*\n/);
  });

  it('shows malformed routes as fixed obsolete-link recovery without fetching or Retry', async () => {
    const pinia = createPinia(); setActivePinia(pinia); const store = useCardStore(); const fetch = vi.spyOn(store, 'fetchCardDetail').mockResolvedValue();
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-OLD-legacy' }, global: { plugins: [pinia] } }); await nextTick();
    expect(fetch).not.toHaveBeenCalled(); expect(wrapper.text()).toContain('Card not found'); expect(wrapper.text()).toContain('This link may be obsolete after a reset.'); expect(wrapper.text()).toContain('Back to Cards'); expect(wrapper.text()).not.toContain('Retry');
    await wrapper.get('button').trigger('click'); expect(wrapper.emitted('back-to-cards')).toHaveLength(1);
  });

  it('shows typed initial and refresh not-found without stale detail or subordinate surfaces', async () => {
    const pinia = createPinia(); setActivePinia(pinia); const store = useCardStore(); vi.spyOn(store, 'fetchCardDetail').mockResolvedValue();
    store.selectedCardId = 'card-a'; store.selectedDetailError = { kind: 'not-found', status: 404, message: 'backend prose' };
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-a' }, global: { plugins: [pinia], stubs: { CardRecordsSection: { template: '<div>accepted records</div>' }, CardConversationsSection: { template: '<div>accepted conversations</div>' } } } }); await nextTick();
    expect(wrapper.text()).toContain('Card not found'); expect(wrapper.text()).toContain('obsolete after a reset'); expect(wrapper.text()).not.toContain('backend prose'); expect(wrapper.text()).not.toContain('Retry');
    store.selectedDetail = { cardId: 'card-a', card: cardView('card-a', { title: 'Accepted old detail' }) }; store.selectedDetailError = null; await nextTick();
    expect(wrapper.text()).toContain('Accepted old detail'); expect(wrapper.text()).toContain('accepted records');
    store.selectedDetail = null; store.selectedDetailError = { kind: 'not-found', status: 404, message: 'gone' }; store.cardRecords.brief.accepted = null; await nextTick();
    expect(wrapper.text()).toContain('Card not found'); expect(wrapper.text()).not.toContain('Accepted old detail'); expect(wrapper.text()).not.toContain('accepted records'); expect(wrapper.text()).not.toContain('accepted conversations');
  });

  it('excludes prior-route success, loading, and error while a new valid route is pending, then renders only its result', async () => {
    const pinia = createPinia(); setActivePinia(pinia); const store = useCardStore();
    store.selectedCardId = 'card-a'; store.selectedDetail = { cardId: 'card-a', card: cardView('card-a', { title: 'Old route success' }) }; store.selectedDetailLoading = true; store.selectedDetailError = { kind: 'network', status: null, message: 'Old route error' };
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, 'fetchCardDetail').mockImplementation(async (id) => { store.selectedCardId = id; store.selectedDetail = null; store.selectedDetailLoading = true; store.selectedDetailError = null; await pending; store.selectedDetail = { cardId: id, card: cardView(id, { title: 'New route result' }) }; store.selectedDetailLoading = false; });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-b' }, global: { plugins: [pinia], stubs: { CardRecordsSection: true, CardConversationsSection: true } } });
    expect(wrapper.text()).toContain('Loading card'); expect(wrapper.text()).not.toContain('Old route success'); expect(wrapper.text()).not.toContain('Old route error'); expect(store.fetchCardDetail).toHaveBeenCalledTimes(1);
    release(); await pending; await nextTick(); expect(wrapper.text()).toContain('New route result'); expect(wrapper.text()).not.toContain('Old route success');
  });

  it('keeps valid current detail and generic transient Retry behavior', async () => {
    const pinia = createPinia(); setActivePinia(pinia); const store = useCardStore(); vi.spyOn(store, 'fetchCardDetail').mockResolvedValue();
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-a' }, global: { plugins: [pinia], stubs: { CardRecordsSection: true, CardConversationsSection: true } } });
    store.selectedCardId = 'card-a'; store.selectedDetail = { cardId: 'card-a', card: cardView('card-a', { title: 'Current valid detail' }) }; await nextTick(); expect(wrapper.text()).toContain('Current valid detail');
    store.selectedDetailFreshness = { refreshing: false, stale: true, staleReason: 'refresh-failed', refreshError: 'temporary refresh outage' }; await nextTick(); expect(wrapper.text()).toContain('Current valid detail'); expect(wrapper.text()).toContain('temporary refresh outage'); expect(wrapper.get('button').text()).toBe('Retry');
    store.selectedDetailFreshness = { refreshing: false, stale: false, staleReason: null, refreshError: null };
    store.selectedDetail = null; store.selectedDetailError = { kind: 'network', status: null, message: 'temporary outage' }; await nextTick(); expect(wrapper.text()).toContain('Network error'); expect(wrapper.text()).toContain('temporary outage'); expect(wrapper.get('button').text()).toBe('Retry');
  });

  it('surfaces record outputs through the dedicated records section', () => {
    expect(detailSource).toContain('<CardRecordsSection :card-id="currentCard.id" />');
    expect(recordsSource).toContain('DocumentFrame');
    expect(recordsSource).toContain('<MarkdownText v-if="contentValue(slot.key)"');
    expect(recordsSource).toContain("staleReason === 'refresh-failed'");
    expect(recordsSource).toContain("key: 'brief'");
    expect(recordsSource).toContain("key: 'status'");
    expect(recordsSource).toContain("key: 'review'");
  });

  it('demotes version history into a secondary, lazily mounted disclosure', () => {
    expect(detailSource).toContain('Version history');
    expect(detailSource).toContain('CardHistoryPanel v-if="historyOpen"');
  });

  it('surfaces agent conversations tied to the card', () => {
    expect(detailSource).toContain('CardConversationsSection');
  });

  it('does not expose direct card mutation controls or store actions', () => {
    expect(detailSource).not.toMatch(/createCard|updateCard|deleteCard|restartCard|abortSubtree|mark.*correction/i);
    expect(detailSource).not.toMatch(/@click="[^\"]*(?:save|delete|restart|abort|correction)/i);
    expect(detailSource).not.toMatch(/class="[^"]*(?:save|delete|restart|abort|correction)[^"]*"/i);
    expect(detailSource).not.toMatch(/@submit/);
  });
});
