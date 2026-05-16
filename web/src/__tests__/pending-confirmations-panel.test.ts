import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PendingConfirmationsPanel from '../components/cards/PendingConfirmationsPanel.vue';

vi.mock('../api/client', () => ({
  getDoctor: vi.fn(), getDebugSupervision: vi.fn(), getDebugState: vi.fn(), getDebugErrors: vi.fn(), getDebugTimeline: vi.fn(),
  listProcesses: vi.fn(), terminateProcess: vi.fn(), getMcpTools: vi.fn(), listNotes: vi.fn(), acknowledgeNote: vi.fn(), deleteNote: vi.fn(), clearAllNotes: vi.fn(), pauseRuntime: vi.fn(), resumeRuntime: vi.fn(),
  listNotifications: vi.fn(), acknowledgeNotification: vi.fn(), listControlActions: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } },
}));
vi.mock('../stores/ws', () => ({ useWsStore: () => ({ onType: vi.fn(() => vi.fn()) }) }));

import { listControlActions, ApiError } from '../api/client';

describe('PendingConfirmationsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
  });

  it('renders success path with preview-only rejected audit entries', async () => {
    vi.mocked(listControlActions).mockResolvedValue({
      control_actions: [{
        id: 'ca-1',
        actor: 'analyst',
        surface: 'web-chat',
        action: 'card.update',
        target_kind: 'card',
        target_id: 'card-1',
        params_summary: 'summary',
        confirmed: false,
        outcome: 'rejected',
        outcome_summary: 'preview-only: confirmation and matching preview_hash required',
        created_at: '2025-01-01T00:00:00Z',
      }],
      total: 1,
    });

    const wrapper = mount(PendingConfirmationsPanel, { global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.text()).toContain('Pending confirmations');
    expect(wrapper.text()).toContain('preview-only: confirmation and matching preview_hash required');
    expect(wrapper.text()).toContain('card.update');
    expect(wrapper.text()).toContain('web-chat');
    expect(wrapper.text()).toContain('analyst');
    expect(wrapper.findAll('button').map((button) => button.text())).toEqual(['Refresh']);
  });

  it('filters out non-preview or non-rejected audit entries', async () => {
    vi.mocked(listControlActions).mockResolvedValue({
      control_actions: [
        {
          id: 'ca-keep', actor: 'analyst', surface: 'web-chat', action: 'card.update', target_kind: 'card', target_id: 'card-1', params_summary: 'summary', confirmed: false, outcome: 'rejected', outcome_summary: 'preview-only: confirmation required', created_at: '2025-01-01T00:00:00Z',
        },
        {
          id: 'ca-non-preview', actor: 'analyst', surface: 'rest', action: 'card.update', target_kind: 'card', target_id: 'card-2', params_summary: 'summary', confirmed: false, outcome: 'rejected', outcome_summary: 'hard rejection without preview', created_at: '2025-01-01T00:00:00Z',
        },
        {
          id: 'ca-non-rejected', actor: 'analyst', surface: 'web-chat', action: 'card.update', target_kind: 'card', target_id: 'card-3', params_summary: 'summary', confirmed: true, outcome: 'ok', outcome_summary: 'preview-only but already applied', created_at: '2025-01-01T00:00:00Z',
        },
      ],
      total: 3,
    });

    const wrapper = mount(PendingConfirmationsPanel, { global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.text()).toContain('preview-only: confirmation required');
    expect(wrapper.text()).not.toContain('hard rejection without preview');
    expect(wrapper.text()).not.toContain('already applied');
    expect(wrapper.text()).toContain('card-1');
    expect(wrapper.text()).not.toContain('card-2');
    expect(wrapper.text()).not.toContain('card-3');
  });

  it('renders loading state while control actions request is pending', async () => {
    let resolveRequest: (value: { control_actions: any[]; total: number }) => void = () => {};
    vi.mocked(listControlActions).mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));

    const wrapper = mount(PendingConfirmationsPanel, { global: { plugins: [createPinia()] } });
    await Promise.resolve();
    expect(wrapper.text()).toContain('Loading pending confirmations…');

    resolveRequest({ control_actions: [], total: 0 });
    await flushPromises();
  });

  it('renders empty state when no preview-only rejected audit entries exist', async () => {
    vi.mocked(listControlActions).mockResolvedValue({ control_actions: [], total: 0 });

    const wrapper = mount(PendingConfirmationsPanel, { global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.text()).toContain('No preview-only control actions are awaiting follow-up.');
  });

  it('renders error state for non-auth failures', async () => {
    vi.mocked(listControlActions).mockRejectedValue(new ApiError(500, 'Server exploded', {}));

    const wrapper = mount(PendingConfirmationsPanel, { global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('Server exploded');
  });

  it('renders unauthorized state', async () => {
    vi.mocked(listControlActions).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));

    const wrapper = mount(PendingConfirmationsPanel, { global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('Unauthorized. Provide a valid Saivage API token and refresh the page.');
  });
});
