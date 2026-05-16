import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import NotificationsPanel from '../components/cards/NotificationsPanel.vue';
import { useDebugStore } from '../stores/debug';

const wsTypeHandlers = new Map<string, Set<(envelope: any) => void>>();

vi.mock('../api/client', () => ({
  getDoctor: vi.fn(), getDebugSupervision: vi.fn(), getDebugState: vi.fn(), getDebugErrors: vi.fn(), getDebugTimeline: vi.fn(),
  listProcesses: vi.fn(), terminateProcess: vi.fn(), getMcpTools: vi.fn(), listNotes: vi.fn(), acknowledgeNote: vi.fn(), deleteNote: vi.fn(), clearAllNotes: vi.fn(), pauseRuntime: vi.fn(), resumeRuntime: vi.fn(),
  listNotifications: vi.fn(), acknowledgeNotification: vi.fn(), listControlActions: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } },
}));
vi.mock('../stores/ws', () => ({
  useWsStore: () => ({
    onType: (type: string, handler: (envelope: any) => void) => {
      let set = wsTypeHandlers.get(type);
      if (!set) {
        set = new Set();
        wsTypeHandlers.set(type, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
  }),
}));

import { listNotifications, acknowledgeNotification, ApiError } from '../api/client';

function emitActivity(content: Record<string, unknown>): void {
  for (const handler of Array.from(wsTypeHandlers.get('activity') ?? [])) {
    handler({ type: 'activity', content });
  }
}

describe('NotificationsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsTypeHandlers.clear();
    setActivePinia(createPinia());
  });

  it('renders success path and acknowledges notifications', async () => {
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [{ id: 'n-1', session_id: null, kind: 'card_changed', severity: 'warn', payload_summary: 'Card changed', related_card_id: 'card-1', source_actor: 'analyst', source_surface: 'rest', created_at: '2025-01-01T00:00:00Z', delivered_at: null, acknowledged_at: null }], total: 1 });
    vi.mocked(acknowledgeNotification).mockResolvedValue({ notification: { id: 'n-1' } as any });
    const wrapper = mount(NotificationsPanel, { global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Card changed');
    await wrapper.find('[aria-label="Acknowledge notification n-1"]').trigger('click');
    await flushPromises();
    expect(acknowledgeNotification).toHaveBeenCalledWith('n-1');
  });

  it('renders empty state', async () => {
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [], total: 0 });
    const wrapper = mount(NotificationsPanel, { global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.text()).toContain('No pending operator notifications.');
  });

  it('renders unauthorized state', async () => {
    vi.mocked(listNotifications).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));
    const wrapper = mount(NotificationsPanel, { global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Unauthorized');
  });

  it('refreshes notifications from websocket notification activity without manual reload', async () => {
    const store = useDebugStore();
    store.setupWsListener();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [], total: 0 })
      .mockResolvedValueOnce({ notifications: [{ id: 'n-added', session_id: null, kind: 'card_changed', severity: 'warn', payload_summary: 'Added from websocket', related_card_id: 'card-1', source_actor: 'analyst', source_surface: 'rest', created_at: '2025-01-01T00:00:00Z', delivered_at: null, acknowledged_at: null }], total: 1 })
      .mockResolvedValueOnce({ notifications: [], total: 0 });

    await store.fetchNotifications();
    expect(store.notificationsTotal).toBe(0);

    emitActivity({ event: 'notification_added', related_card_id: 'card-1' });
    await flushPromises();
    expect(vi.mocked(listNotifications)).toHaveBeenCalledTimes(2);
    expect(store.notificationsTotal).toBe(1);
    expect(store.notifications[0]?.id).toBe('n-added');

    emitActivity({ event: 'notification_acknowledged', related_card_id: 'card-1' });
    await flushPromises();
    expect(vi.mocked(listNotifications)).toHaveBeenCalledTimes(3);
    expect(store.notificationsTotal).toBe(0);
    expect(store.notificationsState).toBe('empty');
  });
});