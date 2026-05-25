import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import type { FileContent, CardReviewSummary, WsEnvelope } from '../api/types';
import CardDetailView from '../components/cards/CardDetailView.vue';
import { useCardStore } from '../stores/cards';
import { useWsStore } from '../stores/ws';
import { useAnalystChat } from '../stores/analystChat';

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(), createCard: vi.fn(), updateCard: vi.fn(), deleteCard: vi.fn(),
  getFileContent: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));

import { getFileContent } from '../api/client';
vi.mock('../utils/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
const mockedGetFileContent = vi.mocked(getFileContent) as unknown as { mockResolvedValue(value: FileContent): void; mockRejectedValue(error: unknown): void; };

function primeStore(pinia: Pinia, opts?: { redactedOnly?: boolean; emptyEvidence?: boolean; detailError?: any; stale?: boolean; review?: CardReviewSummary; hasUnfinishedChildWork?: boolean; plannerDeclaredDone?: boolean; result?: Record<string, unknown> | null; priority?: number; allowedActions?: string[]; }) {
  setActivePinia(pinia);
  const store = useCardStore();
  store.currentCard = { id: 'card-1', type: 'code', parent: null, depth: 0, title: 'Card 1', description: '', status: 'done', tags: [], priority: opts?.priority ?? 1, urgency: 'normal', created_by: 'user', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', depends_on: ['goal-1'], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, notes: [], result: opts?.result ?? null, ...(opts?.allowedActions ? { allowedActions: opts.allowedActions } : {}) } as any;
  store.currentChildren = [{ id: 'child-1', type: 'test', parent: 'card-1', depth: 1, title: 'Child', description: '', status: 'running', tags: [], priority: 1, urgency: 'normal', created_by: 'user', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 } as any];
  store.currentAncestorIds = ['project'];
  store.currentEvidence = opts?.emptyEvidence
    ? { generatedFiles: [], verificationCommands: [], artifactPaths: [], toolErrors: [], summary: { state: 'none-recorded', summary: 'No evidence has been recorded for this card.', hasRecordedEvidence: false, hasDurableEvidence: false, missingCount: 0, blockedCount: 0, redactedCount: 0, fileCount: 0, verificationCount: 0, toolErrorCount: 0, parseRecovered: false } }
    : opts?.redactedOnly
    ? { generatedFiles: [{ path: '.saivage/saivage.json', source: 'result.artifact_paths', exists: true, redactedOnly: true, previewable: true, blocked: false, sensitivity: 'sensitive-redacted' }], verificationCommands: [], artifactPaths: [], toolErrors: [], summary: { state: 'redacted', summary: '1 recorded evidence file is available only with redaction.', hasRecordedEvidence: true, hasDurableEvidence: true, missingCount: 0, blockedCount: 0, redactedCount: 1, fileCount: 1, verificationCount: 0, toolErrorCount: 0, parseRecovered: false } }
    : { generatedFiles: [ { path: 'reports/generated.txt', source: 'result.generated_files', exists: true, previewable: true, blocked: false, sensitivity: 'normal' }, { path: '.saivage/auth-profiles.json', source: 'result.artifact_paths', exists: false, previewable: false, blocked: true, downloadable: false, sensitivity: 'sensitive-blocked', availabilityReason: 'Path is outside the project root.' } ], verificationCommands: [{ command: 'npm test', process_id: 'p1', status: 'completed', exit_code: 0, timed_out: false }], artifactPaths: ['reports/generated.txt'], toolErrors: ['tool warning'], parseFailure: { message: 'bad json' }, summary: { state: 'blocked', summary: '1 recorded evidence path is blocked by file-access security.', hasRecordedEvidence: true, hasDurableEvidence: true, missingCount: 0, blockedCount: 1, redactedCount: 0, fileCount: 2, verificationCount: 1, toolErrorCount: 1, parseRecovered: true } };
  store.currentLifecycle = { status: 'done', terminal: true, phase: 'completed', explanation: 'This card is marked done; review and evidence determine whether operators should accept completion.', completionState: 'marked-done', error: null, startedAt: null, completedAt: null, durationMs: null, retries: 0, childCounts: { drafting: 0, backlog: 0, active: 0, running: 1, blocked: 0, changed: 0, done: 0, failed: 0, cancelled: 0, needs_verification: 0 }, hasActiveChildren: true, hasBlockingChildren: false, dependencyIds: ['goal-1'], blockedByDependencyIds: ['goal-1'] };
  store.currentReview = opts?.review || { status: 'not-run', review: null, evidenceStatus: 'none', summary: 'No review result was returned by the card detail API.' };
  store.currentPlanning = { status: 'done', summary: 'Planner completed', blockedReason: null, createdCardIds: ['child-1'], updatedCardIds: [], reviewSummary: null, hasUnfinishedChildWork: opts?.hasUnfinishedChildWork ?? false, plannerDeclaredDone: opts?.plannerDeclaredDone ?? true };
  store.currentDispatches = { outgoing: [{ dispatchId: 'd1', direction: 'outgoing', parentCardId: 'card-1', targetCardId: 'child-1', targetKind: 'terminal_card', status: 'completed', outcome: 'done', summary: 'done', error: null, evidenceCardIds: ['child-1'], completedAt: '2025-01-01T00:00:00Z' }], incoming: [] };
  store.currentDetailError = opts?.detailError || null;
  store.currentDetailFreshness = { isStale: opts?.stale || false, lastLoadedAt: '2025-01-01T00:00:00Z', staleReason: opts?.stale ? 'ws-card-updated' : null };
  store.cardHistory = [{ version_seq: 2, changed_fields: ['title'], change_summary: 'updated title', changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'web-chat', change_reason: 'reason' } as any];
  store.cardHistorySelectedSeq = 2;
  store.fetchCardDetail = vi.fn(async () => undefined) as any;
  store.fetchCardHistoryForCard = vi.fn(async () => undefined) as any;
  store.selectCardHistoryVersion = vi.fn(async () => undefined) as any;
  return store;
}

function invokeHandler(handler: ((envelope: WsEnvelope) => void) | null, envelope: WsEnvelope) {
  if (!handler) throw new Error('missing activity handler');
  handler(envelope);
}

describe('CardDetailView generated file inspection', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders lifecycle, hierarchy, evidence, and dispatch summaries', async () => {
    const pinia = createPinia();
    primeStore(pinia, { allowedActions: ['card.restart', 'card.delete'] });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Completion & blockers');
    expect(wrapper.text()).toContain('Hierarchy');
    expect(wrapper.text()).toContain('Review result');
    expect(wrapper.text()).toContain('Dispatch summary');
    expect(wrapper.text()).toContain('child-1');
  });

  it('renders unfinished child work warning from planning summary returned by the API/store', async () => {
    const pinia = createPinia();
    primeStore(pinia, { hasUnfinishedChildWork: true, plannerDeclaredDone: true });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Planner declared work done, but unfinished child work is still indicated.');
  });


  it('renders matrix-derived allowed actions from the card payload', async () => {
    const pinia = createPinia();
    primeStore(pinia, { allowedActions: ['card.restart', 'card.delete'] });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.get('[data-testid="allowed-actions"]').text()).toContain('restart');
    expect(wrapper.get('[data-testid="allowed-actions"]').text()).toContain('delete');
  });

  it('renders priority on the 0-100 scale without /10 suffix', async () => {
    const pinia = createPinia();
    primeStore(pinia, { priority: 90 });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Priority');
    expect(wrapper.text()).toContain('90');
    expect(wrapper.text()).not.toContain('/ 10');
  });

  it('renders the empty evidence state as one sentence without counters or preview placeholder', async () => {
    const pinia = createPinia();
    primeStore(pinia, { emptyEvidence: true });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain('No evidence has been recorded for this card.');
    expect(wrapper.text().match(/No evidence has been recorded for this card\./g)).toHaveLength(1);
    expect(wrapper.text()).not.toContain('Files: 0');
    expect(wrapper.text()).not.toContain('Select a generated file to preview');
    expect(wrapper.html()).toMatchSnapshot();
  });

  it('renders non-empty evidence with summary counters and file list', async () => {
    const pinia = createPinia();
    primeStore(pinia);
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Files: 2');
    expect(wrapper.text()).toContain('Checks: 1');
    expect(wrapper.text()).toContain('Tool errors: 1');
    expect(wrapper.findAll('.generated-file-row')).toHaveLength(2);
    expect(wrapper.text()).not.toContain('No evidence has been recorded for this card.');
    expect(wrapper.html()).toMatchSnapshot();
  });

  it('renders structured result values in a formatted pre/code JSON block', async () => {
    const pinia = createPinia();
    primeStore(pinia, { result: { planning: { status: 'blocked', blocked_reason: 'needs input' } } });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    const code = wrapper.get('section.detail-section .code-block');
    expect(code.text()).toContain('"planning":');
    expect(code.text()).toContain('"blocked_reason": "needs input"');
    expect(wrapper.html()).toMatchSnapshot();
  });

  it('loads read-only preview for selected file', async () => {
    const pinia = createPinia();
    primeStore(pinia);
    mockedGetFileContent.mockResolvedValue({ path: 'reports/generated.txt', size: 12, contentType: 'text/plain', content: 'hello world' });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    await wrapper.findAll('.generated-file-row')[0].trigger('click');
    await flushPromises();
    expect(getFileContent).toHaveBeenCalledWith('reports/generated.txt');
    expect(wrapper.text()).toContain('hello world');
  });

  it('shows blocked reason and avoids preview request for blocked file', async () => {
    const pinia = createPinia();
    primeStore(pinia);
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    await wrapper.findAll('.generated-file-row')[1].trigger('click');
    await flushPromises();
    expect(getFileContent).not.toHaveBeenCalledWith('.saivage/auth-profiles.json');
    expect(wrapper.text()).toContain('Path is outside the project root.');
  });

  it('shows redaction notice when preview content is redacted', async () => {
    const pinia = createPinia();
    primeStore(pinia, { redactedOnly: true });
    mockedGetFileContent.mockResolvedValue({ path: '.saivage/saivage.json', size: 12, contentType: 'text/plain', content: '{"apiKey":"[REDACTED]"}', redacted: true, sensitivity: 'sensitive-redacted' });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    await wrapper.find('.generated-file-row').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Sensitive values are redacted by the server.');
  });

  it('shows structured unauthorized error copy', async () => {
    const pinia = createPinia();
    primeStore(pinia, { detailError: { kind: 'unauthorized', status: 401, message: 'Unauthorized. Provide a valid Saivage API token and refresh the card.' } });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Unauthorized');
  });

  it('shows stale banner', async () => {
    const pinia = createPinia();
    primeStore(pinia, { stale: true });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain('This card detail may be stale');
  });

  it('soft-refreshes and highlights on matching activity events', async () => {
    const pinia = createPinia();
    const store = primeStore(pinia);
    const wsStore = useWsStore();
    let activityHandler: ((envelope: WsEnvelope) => void) | null = null;
    vi.spyOn(wsStore, 'onType').mockImplementation(((type: string, handler: (envelope: WsEnvelope) => void) => {
      if (type === 'activity') activityHandler = handler;
      return vi.fn();
    }) as any);

    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(store.fetchCardDetail).toHaveBeenCalledTimes(1);

    invokeHandler(activityHandler, { type: 'activity', timestamp: new Date().toISOString(), content: { event: 'card_history_appended', card_id: 'card-1' } } as WsEnvelope);
    await flushPromises();

    expect(store.fetchCardDetail).toHaveBeenCalledTimes(2);
    expect(store.fetchCardHistoryForCard).toHaveBeenCalledWith('card-1');
    expect(store.selectCardHistoryVersion).toHaveBeenCalledWith('card-1', 2);
    expect(wrapper.get('[data-testid="card-detail-highlight"]').classes()).toContain('live-highlight');

    vi.advanceTimersByTime(1800);
    await flushPromises();
    expect(wrapper.get('[data-testid="card-detail-highlight"]').classes()).not.toContain('live-highlight');

    invokeHandler(activityHandler, { type: 'activity', timestamp: new Date().toISOString(), content: { event: 'analyst_tool_invoked', related_card_id: 'card-1' } } as WsEnvelope);
    await flushPromises();
    expect(store.fetchCardDetail).toHaveBeenCalledTimes(3);
  });

  it('reuses a stable per-card analyst session and seeds card context with get_card only as needed', async () => {
    const pinia = createPinia();
    const cardStore = primeStore(pinia);
    cardStore.currentCard = {
      ...cardStore.currentCard!,
      id: 'card-1',
      title: 'Fix overlay',
      description: 'Drawer overlaps routed content',
      status: 'active',
      blocks: ['child-2'],
      depends_on: ['dep-2'],
      version_seq: 8,
    } as any;
    const analystChat = useAnalystChat();
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();
    const button = wrapper.get('.discuss-btn');
    expect(button.attributes('aria-label')).toBe('Seed analyst chat with this card');
    const seedSpy = vi.spyOn(analystChat, 'seedCardContext');
    const focusSpy = vi.fn();
    window.addEventListener('saivage:focus-chat', focusSpy);

    await button.trigger('click');
    await flushPromises();
    expect(seedSpy).toHaveBeenCalledTimes(1);
    expect(seedSpy).toHaveBeenCalledWith(cardStore.currentCard);
    expect(focusSpy).toHaveBeenCalledTimes(1);
    const firstHint = analystChat.syntheticHint.content;
    expect(analystChat.activeSessionId).toBe('card-card-1');
    expect(firstHint).toContain('Card title: Fix overlay');
    expect(firstHint).toContain('Card description: Drawer overlaps routed content');
    expect(firstHint).toContain('Card status: active');
    expect(firstHint).toContain('blocks:child-2');
    expect(firstHint).toContain('Tool result get_card:');
    expect(firstHint).toContain('\"tool\":\"get_card\"');

    await button.trigger('click');
    await flushPromises();
    expect(seedSpy).toHaveBeenCalledTimes(2);
    expect(focusSpy).toHaveBeenCalledTimes(2);
    window.removeEventListener('saivage:focus-chat', focusSpy);
    expect(analystChat.activeSessionId).toBe('card-card-1');
    expect(analystChat.syntheticHint.content).toBe(firstHint);
  });

  it('ignores unrelated events and cleans up websocket subscription on unmount', async () => {
    const pinia = createPinia();
    const store = primeStore(pinia);
    const wsStore = useWsStore();
    let activityHandler: ((envelope: WsEnvelope) => void) | null = null;
    const unsubscribe = vi.fn();
    vi.spyOn(wsStore, 'onType').mockImplementation(((type: string, handler: (envelope: WsEnvelope) => void) => {
      if (type === 'activity') activityHandler = handler;
      return unsubscribe;
    }) as any);

    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [pinia] } });
    await flushPromises();

    invokeHandler(activityHandler, { type: 'activity', timestamp: new Date().toISOString(), content: { event: 'card_history_appended', card_id: 'card-2' } } as WsEnvelope);
    await flushPromises();
    expect(store.fetchCardDetail).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ cardId: 'card-2' });
    await flushPromises();
    expect(unsubscribe.mock.calls.length).toBeGreaterThanOrEqual(2);

    wrapper.unmount();
    expect(unsubscribe.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
