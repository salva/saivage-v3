import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CardHistoryPanel from '../components/cards/CardHistoryPanel.vue';
import { useCardStore } from '../stores/cards';

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(),
  listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));
import { listCardHistory, getCardHistoryEntry, getCardDiff, ApiError } from '../api/client';

describe('CardHistoryPanel', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    vi.clearAllMocks();
    pinia = createPinia();
    setActivePinia(pinia);
    const store = useCardStore();
    store.currentCard = { id: '11111111-1111-4111-8111-111111111111', version_seq: 3 } as any;
  });

  it('renders success path with history list, entry details, and diff rows', async () => {
    vi.mocked(listCardHistory).mockResolvedValue({ history: [{ entry_id: 'entry-2-uuid', kind: 'update' as const, card_id: '11111111-1111-4111-8111-111111111111', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'rest', change_reason: 'update', changed_fields: ['acceptance'], change_summary: 'acceptance updated' }], total: 1 });
    vi.mocked(getCardHistoryEntry).mockResolvedValue({ entry: { entry_id: 'entry-2-uuid', kind: 'update' as const, card_id: '11111111-1111-4111-8111-111111111111', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'rest', change_reason: 'update', changed_fields: ['acceptance'], change_summary: 'acceptance updated', snapshot: { id: '11111111-1111-4111-8111-111111111111', acceptance: 'before' } as any } });
    vi.mocked(getCardDiff).mockResolvedValue({ card_id: '11111111-1111-4111-8111-111111111111', from: 2, to: 3, diff: [{ field: 'acceptance', before: 'before', after: 'after' }] });

    const wrapper = mount(CardHistoryPanel, { props: { cardId: '11111111-1111-4111-8111-111111111111' }, global: { plugins: [pinia] } });
    await flushPromises();

    expect(wrapper.text()).toContain('acceptance updated');
    expect(wrapper.text()).toContain('Diff vs current card');
    expect(wrapper.text()).toContain('before');
    expect(wrapper.text()).toContain('after');
  });

  it('renders loading state while history request is pending', async () => {
    let resolveHistory: (value: { history: any[]; total: number }) => void = () => {};
    vi.mocked(listCardHistory).mockReturnValue(new Promise((resolve) => { resolveHistory = resolve; }));

    const wrapper = mount(CardHistoryPanel, { props: { cardId: '11111111-1111-4111-8111-111111111111' }, global: { plugins: [pinia] } });
    await Promise.resolve();
    expect(wrapper.text()).toContain('Loading card history…');

    resolveHistory({ history: [], total: 0 });
    await flushPromises();
  });

  it('renders empty state when no history exists', async () => {
    vi.mocked(listCardHistory).mockResolvedValue({ history: [], total: 0 });
    const wrapper = mount(CardHistoryPanel, { props: { cardId: '11111111-1111-4111-8111-111111111111' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain('No tracked card history exists yet for this card.');
  });

  it('renders unauthorized state', async () => {
    vi.mocked(listCardHistory).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));
    const wrapper = mount(CardHistoryPanel, { props: { cardId: '11111111-1111-4111-8111-111111111111' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Unauthorized');
  });

  it('renders detail failure state when selected version fetch fails', async () => {
    vi.mocked(listCardHistory).mockResolvedValue({ history: [{ entry_id: 'entry-2-uuid', kind: 'update' as const, card_id: '11111111-1111-4111-8111-111111111111', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'rest', change_reason: 'update', changed_fields: ['acceptance'], change_summary: 'acceptance updated' }], total: 1 });
    vi.mocked(getCardHistoryEntry).mockRejectedValue(new ApiError(500, 'History detail failed', {}));
    vi.mocked(getCardDiff).mockRejectedValue(new ApiError(500, 'History detail failed', {}));

    const wrapper = mount(CardHistoryPanel, { props: { cardId: '11111111-1111-4111-8111-111111111111' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('History detail failed');
  });

  it('redacts secret-bearing snapshot and diff payloads before rendering', async () => {
    vi.mocked(listCardHistory).mockResolvedValue({ history: [{ entry_id: 'entry-2-uuid', kind: 'update' as const, card_id: '11111111-1111-4111-8111-111111111111', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'rest', change_reason: 'update', changed_fields: ['config', 'env'], change_summary: 'sensitive payload update' }], total: 1 });
    vi.mocked(getCardHistoryEntry).mockResolvedValue({ entry: { entry_id: 'entry-2-uuid', kind: 'update' as const, card_id: '11111111-1111-4111-8111-111111111111', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'rest', change_reason: 'update', changed_fields: ['config', 'env'], change_summary: 'sensitive payload update', snapshot: { id: '11111111-1111-4111-8111-111111111111', auth_profile: { token: 'sk-live-raw-secret' }, env_value: 'process.env.OPENAI_API_KEY', safe_field: 'visible' } as any } });
    vi.mocked(getCardDiff).mockResolvedValue({ card_id: '11111111-1111-4111-8111-111111111111', from: 2, to: 3, diff: [{ field: 'config_blob', before: 'Bearer very-secret-token', after: 'sk-updated-secret' }, { field: 'safe_field', before: 'before', after: 'after' }] });

    const wrapper = mount(CardHistoryPanel, { props: { cardId: '11111111-1111-4111-8111-111111111111' }, global: { plugins: [pinia] } });
    await flushPromises();

    expect(wrapper.text()).toContain('[redacted]');
    expect(wrapper.text()).toContain('visible');
    expect(wrapper.text()).toContain('before');
    expect(wrapper.text()).toContain('after');
    expect(wrapper.text()).not.toContain('sk-live-raw-secret');
    expect(wrapper.text()).not.toContain('Bearer very-secret-token');
    expect(wrapper.text()).not.toContain('sk-updated-secret');
    expect(wrapper.text()).not.toContain('process.env.OPENAI_API_KEY');
  });
});
