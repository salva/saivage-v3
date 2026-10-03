import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CardRecordsSection from '../components/cards/CardRecordsSection.vue';
import { useCardStore } from '../stores/cards';
import { cardView } from './card-view-fixtures';
import type { CardRecordContentResponse, RecordVersionContentResponse } from '../api/types';

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getCardRecord: vi.fn(), listCardRecords: vi.fn(), getCard: vi.fn(),
  listRecordHistory: vi.fn(), getRecordVersion: vi.fn(), getRecordDiff: vi.fn(),
}));
import { OperatorApiError, getCard, getCardRecord, listCardRecords, listRecordHistory, getRecordVersion, getRecordDiff } from '../api/client';

const A = 'card-a';
const name = 'brief.md';
const descriptor = { name, format: 'markdown' as const, schema: 'brief.v1', bootstrap: true, current: null };
const entryId = '11111111-1111-4111-8111-111111111111';
const time = '2026-07-18T00:00:00Z';
function content(cardId = A): CardRecordContentResponse {
  return { card_id: cardId, record: { name, revision: 4, current_url: `record:///${name}?card=${cardId}`,
    accepted_version_url: `record:///${name}?card=${cardId}&v=4`, state: 'closed',
    accepted: { source_version: 4, source_entry_id: entryId, committed_at: time, writer_agent: 'analyst',
      card_version_seq: 1, card_history_version: 1, card_history_entry_id: entryId,
      content: 'accepted brief', content_sha256: 'a'.repeat(64), size_bytes: 14 },
    draft: null, effective_content_source: 'accepted' } };
}
function selected(version: number, cardId = A): RecordVersionContentResponse {
  const accepted = { ...content(cardId).record.accepted!, source_version: version, content: `historical brief ${version}` };
  return { card_id: cardId, name, version, version_url: `record:///${name}?card=${cardId}&v=${version}`,
    entry_id: entryId, published_at: time, artifact: { published_at: time, accepted } };
}
function catalog(cardId = A) {
  return { card_id: cardId, name, versions: [1, 2, 4].map((version) => ({ entry_id: entryId,
    version, published_at: time, version_url: selected(version, cardId).version_url })), total: 3 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const wrappers: ReturnType<typeof mount>[] = [];
function render(recordRefinement?: { record: string | null; version: number | null }) {
  const errors = vi.fn();
  const wrapper = mount(CardRecordsSection, { props: { cardId: A, recordRefinement },
    global: { stubs: { RouterLink: true }, config: { errorHandler: errors } } });
  wrappers.push(wrapper);
  return { wrapper, errors };
}
async function admit(cardId = A) {
  const store = useCardStore();
  await store.fetchCardDetail(cardId);
  return store;
}

describe('CardRecordsSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
    vi.mocked(getCard).mockImplementation(async (id) => ({ card: cardView(id) }));
    vi.mocked(listCardRecords).mockImplementation(async (id) => ({ card_id: id, records: [descriptor] }));
    vi.mocked(getCardRecord).mockImplementation(async (id) => content(id));
    vi.mocked(listRecordHistory).mockImplementation(async (id) => catalog(id));
    vi.mocked(getRecordVersion).mockImplementation(async (id, _name, version) => selected(version, id));
    vi.mocked(getRecordDiff).mockImplementation(async (id, _name, version) => ({ card_id: id, name,
      from: version, to: { kind: 'current', revision: 4, accepted_version: 4 }, view: 'effective', hunks: [] }));
  });
  afterEach(() => { wrappers.splice(0).forEach((wrapper) => wrapper.unmount()); });

  it('waits for descriptors and initial current completion, applying only the latest semantic query', async () => {
    const definitions = deferred<Awaited<ReturnType<typeof listCardRecords>>>();
    const current = deferred<CardRecordContentResponse>();
    vi.mocked(listCardRecords).mockReturnValue(definitions.promise);
    vi.mocked(getCardRecord).mockReturnValue(current.promise);
    const store = await admit();
    const { wrapper, errors } = render({ record: name, version: 1 });
    await wrapper.setProps({ recordRefinement: { record: name, version: 2 } });
    expect(getRecordVersion).not.toHaveBeenCalled();
    definitions.resolve({ card_id: A, records: [descriptor] });
    await flushPromises();
    expect(wrapper.text()).toContain('Loading brief.md');
    expect(listRecordHistory).not.toHaveBeenCalled();
    expect(getRecordVersion).not.toHaveBeenCalled();
    current.resolve(content());
    await flushPromises();
    expect(getRecordVersion).toHaveBeenCalledExactlyOnceWith(A, name, 2, expect.any(AbortSignal));
    expect(wrapper.text()).toContain('historical brief 2');
    expect(store.cardRecords[name]!.selectedVersion).toBe(2);
    await wrapper.setProps({ recordRefinement: { record: name, version: 2 } });
    expect(getRecordVersion).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('shows descriptor failure without invoking invariant-only historical methods', async () => {
    const definitions = deferred<Awaited<ReturnType<typeof listCardRecords>>>();
    vi.mocked(listCardRecords).mockReturnValue(definitions.promise);
    await admit();
    const { wrapper, errors } = render({ record: name, version: 1 });
    definitions.reject(new Error('definitions failed'));
    await flushPromises();
    expect(wrapper.text()).toContain('Could not load record definitions');
    expect(wrapper.text()).toContain('definitions failed');
    expect(getCardRecord).not.toHaveBeenCalled();
    expect(listRecordHistory).not.toHaveBeenCalled();
    expect(getRecordVersion).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it('explicitly reports an undeclared requested record and clears the message on selection change', async () => {
    await admit();
    const { wrapper, errors } = render({ record: 'unknown.md', version: 1 });
    await flushPromises();
    expect(wrapper.text()).toContain("Record 'unknown.md' is not configured for this card.");
    expect(listRecordHistory).not.toHaveBeenCalled();
    expect(getRecordVersion).not.toHaveBeenCalled();
    await wrapper.setProps({ recordRefinement: { record: name, version: 2 } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('Requested record unavailable');
    expect(wrapper.text()).toContain('historical brief 2');
    expect(errors).not.toHaveBeenCalled();
  });

  it('starts exact selection independently of history and never selects an old query after slow history', async () => {
    const oldHistory = deferred<ReturnType<typeof catalog>>();
    vi.mocked(listRecordHistory).mockReturnValueOnce(oldHistory.promise);
    const store = await admit();
    const { wrapper } = render({ record: name, version: 1 });
    await flushPromises();
    expect(wrapper.text()).toContain('Loading record history');
    expect(wrapper.text()).toContain('historical brief 1');
    await wrapper.setProps({ recordRefinement: { record: name, version: 2 } });
    await flushPromises();
    oldHistory.resolve(catalog());
    await flushPromises();
    expect(vi.mocked(getRecordVersion).mock.calls.map((call) => call[2])).toEqual([1, 2]);
    expect(store.cardRecords[name]!.selectedVersion).toBe(2);
    expect(wrapper.text()).toContain('historical brief 2');
  });

  it('lets the server resolve a catalog gap, keeping draft current and exact accepted selection distinct', async () => {
    const current = content();
    const draftTime = '2026-07-19T00:00:00Z';
    vi.mocked(getCardRecord).mockResolvedValue({ ...current, record: { ...current.record,
      revision: 5, state: 'open', draft: { opened_at: time, updated_at: draftTime, content: 'unfinished draft', content_sha256: 'b'.repeat(64) }, effective_content_source: 'draft' } });
    const store = await admit();
    const { wrapper, errors } = render({ record: name, version: 1 });
    await flushPromises();
    const missing = { error: 'historical_version_not_found' as const, resource: 'authored_record' as const, owner_id: `${A}/${name}`, version: 3 };
    vi.mocked(getRecordVersion).mockRejectedValueOnce(new OperatorApiError('cards.records.versions.get', 404, missing));
    vi.mocked(getRecordDiff).mockRejectedValueOnce(new OperatorApiError('cards.records.diff', 404, missing));
    await wrapper.setProps({ recordRefinement: { record: name, version: 3 } });
    await flushPromises();
    expect(getRecordVersion).toHaveBeenLastCalledWith(A, name, 3, expect.any(AbortSignal));
    expect(getRecordDiff).toHaveBeenLastCalledWith(A, name, 3, 'current', 'effective', expect.any(AbortSignal));
    expect(wrapper.get('[role="alert"]').text()).toContain('historical_version_not_found');
    expect(wrapper.find('.selected-record').exists()).toBe(false);
    expect(store.cardRecords[name]!.diffError).toBe('historical_version_not_found');
    expect(wrapper.text()).toContain('Current revision 5 · draft');
    expect(wrapper.text()).toContain(`record:///${name}?card=${A}&v=4`);
    expect(store.cardRecords[name]!.current?.record.accepted?.source_version).toBe(4);
    expect(store.cardRecords[name]!.content).toEqual({ kind: 'content', revision: 5, timestamp: draftTime, content: 'unfinished draft' });
    await store.selectRecordVersion(name, 3);
    await flushPromises();
    expect(wrapper.get('.selected-record').text()).toContain('historical brief 3');
    expect(store.cardRecords[name]!.selectedError).toBeNull();
    expect(store.cardRecords[name]!.diffError).toBeNull();
    expect(store.cardRecords[name]!.history?.versions.map((entry) => entry.version)).toEqual([1, 2, 4]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('invalidates the old-card initial-load continuation on a card switch', async () => {
    const oldCurrent = deferred<CardRecordContentResponse>();
    vi.mocked(getCardRecord).mockReturnValueOnce(oldCurrent.promise);
    const store = await admit();
    const { wrapper, errors } = render({ record: name, version: 1 });
    await flushPromises();
    await store.fetchCardDetail('card-b');
    await wrapper.setProps({ cardId: 'card-b', recordRefinement: { record: name, version: 2 } });
    await flushPromises();
    expect(wrapper.text()).toContain('historical brief 2');
    oldCurrent.resolve(content());
    await flushPromises();
    expect(getRecordVersion).toHaveBeenCalledExactlyOnceWith('card-b', name, 2, expect.any(AbortSignal));
    expect(store.cardRecords[name]!.selected?.card_id).toBe('card-b');
    expect(errors).not.toHaveBeenCalled();
  });

  it('does not resume old-card selection after its slow history settles', async () => {
    const oldHistory = deferred<ReturnType<typeof catalog>>();
    const oldExact = deferred<RecordVersionContentResponse>();
    vi.mocked(listRecordHistory).mockReturnValueOnce(oldHistory.promise);
    vi.mocked(getRecordVersion).mockReturnValueOnce(oldExact.promise);
    const store = await admit();
    const { wrapper, errors } = render({ record: name, version: 1 });
    await flushPromises();
    expect(getRecordVersion).toHaveBeenCalledExactlyOnceWith(A, name, 1, expect.any(AbortSignal));
    await store.fetchCardDetail('card-b');
    await wrapper.setProps({ cardId: 'card-b', recordRefinement: { record: name, version: 2 } });
    await flushPromises();
    oldHistory.resolve(catalog());
    oldExact.resolve(selected(1));
    await flushPromises();
    expect(vi.mocked(getRecordVersion).mock.calls.map((call) => [call[0], call[2]])).toEqual([[A, 1], ['card-b', 2]]);
    expect(store.cardRecords[name]!.selected?.card_id).toBe('card-b');
    expect(wrapper.text()).toContain('historical brief 2');
    expect(wrapper.text()).not.toContain('historical brief 1');
    expect(errors).not.toHaveBeenCalled();
  });

  it('does not apply refinement after unmount while the initial current request is pending', async () => {
    const current = deferred<CardRecordContentResponse>();
    vi.mocked(getCardRecord).mockReturnValue(current.promise);
    await admit();
    const { wrapper, errors } = render({ record: name, version: 2 });
    await flushPromises();
    wrapper.unmount();
    current.resolve(content());
    await flushPromises();
    expect(listRecordHistory).not.toHaveBeenCalled();
    expect(getRecordVersion).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it('keeps successful exact content and locator visible beside current failure and independent resource errors', async () => {
    const current = deferred<CardRecordContentResponse>();
    const history = deferred<ReturnType<typeof catalog>>();
    const exact = deferred<RecordVersionContentResponse>();
    const diff = deferred<Awaited<ReturnType<typeof getRecordDiff>>>();
    vi.mocked(getCardRecord).mockReturnValue(current.promise);
    vi.mocked(listRecordHistory).mockReturnValue(history.promise);
    vi.mocked(getRecordVersion).mockReturnValue(exact.promise);
    vi.mocked(getRecordDiff).mockReturnValue(diff.promise);
    const store = await admit();
    const { wrapper } = render({ record: name, version: 2 });
    await flushPromises();
    current.reject(new Error('current read failed'));
    await flushPromises();
    expect(wrapper.text()).toContain('current read failed');
    expect(wrapper.text()).toContain('Loading record history');
    expect(wrapper.text()).toContain('Loading selected record version');
    exact.resolve(selected(2));
    await flushPromises();
    expect(wrapper.text()).toContain('historical brief 2');
    expect(wrapper.text()).toContain(selected(2).version_url);
    expect(wrapper.text()).toContain('current read failed');
    history.reject(new Error('history failed'));
    diff.reject(new Error('current comparison unavailable'));
    await flushPromises();
    expect(wrapper.text()).toContain('historical brief 2');
    expect(wrapper.text()).toContain('history failed');
    expect(wrapper.text()).toContain('current comparison unavailable');
    expect(wrapper.find('.record-diff').exists()).toBe(false);
    expect(store.cardRecords[name]!.content).toBeNull();
    expect(store.cardRecords[name]!.current).toBeNull();
    expect(store.cardRecords[name]!.error).toBe('current read failed');
    vi.mocked(getRecordVersion).mockResolvedValue(selected(2));
    vi.mocked(getRecordDiff).mockResolvedValue({ card_id: A, name, from: 2,
      to: { kind: 'current', revision: 4, accepted_version: 4 }, view: 'effective', hunks: [] });
    const retryDiff = wrapper.findAll('.record-history-error button').find((button) => button.text() === 'Retry diff')!;
    expect(retryDiff.attributes('disabled')).toBeUndefined();
    await retryDiff.trigger('click');
    await flushPromises();
    expect(getRecordVersion).toHaveBeenLastCalledWith(A, name, 2, expect.any(AbortSignal));
    expect(getRecordDiff).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('historical brief 2');
    expect(wrapper.text()).toContain('current read failed');
    expect(getCardRecord).toHaveBeenCalledTimes(1);
  });

  it('shows missing exact selection beside current failure and retries that exact version, never current', async () => {
    const current = deferred<CardRecordContentResponse>();
    const exact = deferred<RecordVersionContentResponse>();
    vi.mocked(getCardRecord).mockReturnValue(current.promise);
    vi.mocked(getRecordVersion).mockReturnValueOnce(exact.promise);
    vi.mocked(getRecordDiff).mockRejectedValue(new Error('no current comparison'));
    await admit();
    const { wrapper } = render({ record: name, version: 2 });
    current.reject(new Error('current read failed'));
    await flushPromises();
    exact.reject(new Error('Accepted version 2 not found'));
    await flushPromises();
    expect(wrapper.text()).toContain('current read failed');
    expect(wrapper.text()).toContain('Accepted version 2 not found');
    const retry = wrapper.get('.record-history-error button');
    expect(retry.attributes('disabled')).toBeUndefined();
    await retry.trigger('click');
    await flushPromises();
    expect(getRecordVersion).toHaveBeenLastCalledWith(A, name, 2, expect.any(AbortSignal));
    expect(getRecordVersion).toHaveBeenCalledTimes(2);
    expect(getCardRecord).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('historical brief 2');
    expect(wrapper.text()).toContain('current read failed');
  });

  it.each(['success', 'failure'])('blocks initial manual History without replay, then admits manual selection after %s', async (outcome) => {
    const current = deferred<CardRecordContentResponse>();
    vi.mocked(getCardRecord).mockReturnValue(current.promise);
    const store = await admit();
    const { wrapper } = render();
    await flushPromises();
    const history = wrapper.get('.history-button');
    expect(history.attributes('disabled')).toBeDefined();
    // Dispatch directly too: handler admission must not rely on native disabled-button behavior.
    history.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(listRecordHistory).not.toHaveBeenCalled();
    expect(getRecordVersion).not.toHaveBeenCalled();
    expect(getRecordDiff).not.toHaveBeenCalled();
    expect(store.cardRecords[name]!.selected).toBeNull();
    if (outcome === 'success') current.resolve(content());
    else current.reject(new Error('current read failed'));
    await flushPromises();
    expect(history.attributes('disabled')).toBeUndefined();
    expect(listRecordHistory).not.toHaveBeenCalled();
    await history.trigger('click');
    await flushPromises();
    await wrapper.get('.record-history button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('historical brief 1');
    if (outcome === 'failure') {
      expect(wrapper.text()).toContain('current read failed');
      expect(store.cardRecords[name]!.content).toBeNull();
    } else expect(wrapper.text()).toContain('accepted brief');
  });

  it.each(['catalog', 'selected retry', 'diff retry'])('keeps exposed %s output mounted but rejects its action during initial current loading', async (control) => {
    const store = await admit();
    await flushPromises();
    await store.openRecordHistory(name);
    if (control === 'selected retry') vi.mocked(getRecordVersion).mockRejectedValueOnce(new Error('exact failed'));
    if (control === 'diff retry') vi.mocked(getRecordDiff).mockRejectedValueOnce(new Error('diff failed'));
    if (control !== 'catalog') await store.selectRecordVersion(name, 2);
    const current = deferred<CardRecordContentResponse>();
    vi.mocked(getCardRecord).mockReturnValue(current.promise);
    vi.mocked(listRecordHistory).mockClear();
    vi.mocked(getRecordVersion).mockClear();
    vi.mocked(getRecordDiff).mockClear();
    const { wrapper } = render();
    await flushPromises();
    const button = wrapper.get(control === 'catalog' ? '.record-history button' : '.record-history-error button');
    expect(button.attributes('disabled')).toBeDefined();
    if (control === 'diff retry') expect(wrapper.text()).toContain('historical brief 2');
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(listRecordHistory).not.toHaveBeenCalled();
    expect(getRecordVersion).not.toHaveBeenCalled();
    expect(getRecordDiff).not.toHaveBeenCalled();
    current.resolve(content());
    await flushPromises();
    expect(wrapper.get(control === 'catalog' ? '.record-history button' : '.record-history-error button').attributes('disabled')).toBeUndefined();
    expect(getRecordVersion).not.toHaveBeenCalled();
  });

  it('keeps accepted current content mounted with an exact stale Retry affordance', async () => {
    const store = await admit();
    const { wrapper } = render();
    await flushPromises();
    vi.mocked(getCardRecord).mockRejectedValueOnce(new Error('brief refresh failed'));
    await store.refreshRecord(name, 'invalidated');
    await flushPromises();
    expect(wrapper.text()).toContain('accepted brief');
    expect(wrapper.text()).toContain('brief refresh failed');
    expect(wrapper.get('.record-stale button').text()).toBe('Retry');
    await wrapper.get('.record-stale button').trigger('click');
    await flushPromises();
    expect(getCardRecord).toHaveBeenCalledTimes(3);
    expect(wrapper.find('.record-stale').exists()).toBe(false);
  });
});
