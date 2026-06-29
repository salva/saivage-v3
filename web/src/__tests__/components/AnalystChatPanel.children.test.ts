import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import AnalystChatPanel from '../../components/chat/AnalystChatPanel.vue';
import analystChatPanelSource from '../../components/chat/AnalystChatPanel.vue?raw';
import { useCardStore } from '../../stores/cards';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';

const listChatSessions = vi.fn();
const getChatEntries = vi.fn();
const sendChatMessage = vi.fn();

vi.mock('../../api/client', () => ({
  listChatSessions: (...args: any[]) => listChatSessions(...args),
  getChatEntries: (...args: any[]) => getChatEntries(...args),
  sendChatMessage: (...args: any[]) => sendChatMessage(...args),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));

function card(id: string, parent: string | null, position: number, title: string) {
  return {
    id,
    parent,
    position,
    title,
    status: 'backlog',
    type: 'code',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    created_by: 'analyst',
    version_seq: 1,
    depends_on: [],
    related: [],
    retries: 0,
  } as any;
}

describe('AnalystChatPanel on-screen children', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    listChatSessions.mockReset();
    getChatEntries.mockReset();
    sendChatMessage.mockReset();
    listChatSessions.mockResolvedValue({ sessions: [{ id: 'analyst', role: 'analyst', status: 'active', started_at: '2025-01-01T00:00:00Z' }] });
    getChatEntries.mockResolvedValue({ sessionId: 'analyst', entries: [] });
    sendChatMessage.mockResolvedValue({ sessionId: 'analyst', message: { id: 'm1', role: 'assistant', kind: 'text', content: 'ok', timestamp: '2025-01-01T00:00:00Z' }, toolInvocations: [] });
  });

  it('imports the singular useCardStore symbol from ../../stores/cards', () => {
    expect(analystChatPanelSource).toMatch(/import\s*\{[^}]*\buseCardStore\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/stores\/cards['"]/);
    expect(useCardStore).toBeDefined();
  });

  it('renders children in card position order returned by childrenOf', async () => {
    const pinia = createPinia();
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [pinia] } });
    const cards = useCardStore();
    cards.cards = [
      card('parent', null, 0, 'Parent'),
      card('child-2', 'parent', 2, 'Second'),
      card('child-0', 'parent', 0, 'Zero'),
      card('child-1', 'parent', 1, 'First'),
    ];
    const workspaceRoute = useWorkspaceRouteStore();
    workspaceRoute.view = 'cards';
    workspaceRoute.entityId = 'parent';
    await flushPromises();
    const items = wrapper.findAll('.on-screen-children li').map((item) => item.text());
    expect(items).toEqual(['child-0 — Zero', 'child-1 — First', 'child-2 — Second']);
    wrapper.unmount();
  });

  it('does not render the list outside the cards view', async () => {
    const pinia = createPinia();
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [pinia] } });
    const cards = useCardStore();
    cards.cards = [card('parent', null, 0, 'Parent'), card('child-0', 'parent', 0, 'Zero')];
    const workspaceRoute = useWorkspaceRouteStore();
    workspaceRoute.view = 'dashboard';
    workspaceRoute.entityId = 'parent';
    await flushPromises();
    expect(wrapper.find('.on-screen-children').exists()).toBe(false);
    wrapper.unmount();
  });
});
