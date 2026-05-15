import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CardDetailView from '../components/cards/CardDetailView.vue';
import { useCardStore } from '../stores/cards';

vi.mock('../api/client', () => ({
  listCards: vi.fn(),
  getCard: vi.fn(),
  createCard: vi.fn(),
  updateCard: vi.fn(),
  deleteCard: vi.fn(),
  getFileContent: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } },
}));

import { getFileContent, ApiError } from '../api/client';

vi.mock('../utils/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));

function primeStore(redactedOnly = false) {
  setActivePinia(createPinia());
  const store = useCardStore();
  store.currentCard = { id: 'card-1', type: 'code', parent: null, depth: 0, title: 'Card 1', description: '', status: 'done', tags: [], priority: 1, urgency: 'normal', created_by: 'user', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, notes: [] } as any;
  store.currentChildren = [];
  store.currentAncestorIds = [];
  store.currentEvidence = redactedOnly
    ? { generatedFiles: [{ path: '.saivage/saivage.json', source: 'result.artifact_paths', exists: true }], verificationCommands: [], artifactPaths: [], toolErrors: [] }
    : {
      generatedFiles: [
        { path: 'reports/generated.txt', source: 'result.generated_files', exists: true },
        { path: '.saivage/auth-profiles.json', source: 'result.artifact_paths', exists: true },
      ],
      verificationCommands: [{ command: 'npm test', process_id: 'p1', status: 'completed', exit_code: 0, timed_out: false }],
      artifactPaths: ['reports/generated.txt'],
      toolErrors: ['tool warning'],
      parseFailure: { message: 'bad json' },
    };
  store.fetchCardDetail = vi.fn(async () => undefined) as any;
  return store;
}

describe('CardDetailView generated file inspection', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders generated files and verification commands', async () => {
    primeStore();
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Generated Files & Evidence');
    expect(wrapper.text()).toContain('reports/generated.txt');
    expect(wrapper.text()).toContain('npm test');
  });

  it('loads read-only preview for selected file', async () => {
    primeStore();
    vi.mocked(getFileContent).mockResolvedValue({ path: 'reports/generated.txt', size: 12, contentType: 'text/plain', content: 'hello world' });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [createPinia()] } });
    await flushPromises();
    await wrapper.findAll('.generated-file-row')[0].trigger('click');
    await flushPromises();
    expect(getFileContent).toHaveBeenCalledWith('reports/generated.txt');
    expect(wrapper.text()).toContain('hello world');
  });

  it('shows blocked preview message', async () => {
    primeStore();
    vi.mocked(getFileContent).mockRejectedValue(new ApiError(403, 'blocked'));
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [createPinia()] } });
    await flushPromises();
    await wrapper.findAll('.generated-file-row')[1].trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Preview blocked by file-access security.');
  });

  it('shows missing preview message', async () => {
    primeStore();
    vi.mocked(getFileContent).mockRejectedValue(new ApiError(404, 'missing'));
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [createPinia()] } });
    await flushPromises();
    await wrapper.findAll('.generated-file-row')[0].trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('File was recorded as evidence but is not present in the workspace.');
  });

  it('shows redaction notice when preview content is redacted', async () => {
    primeStore(true);
    vi.mocked(getFileContent).mockResolvedValue({ path: '.saivage/saivage.json', size: 12, contentType: 'text/plain', content: '{"apiKey":"[REDACTED]"}' });
    const wrapper = mount(CardDetailView, { props: { cardId: 'card-1' }, global: { plugins: [createPinia()] } });
    await flushPromises();
    await wrapper.find('.generated-file-row').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Sensitive values are redacted by the server.');
  });
});
