import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import AnalystChatPanel from '../../components/chat/AnalystChatPanel.vue';
import analystChatPanelSource from '../../components/chat/AnalystChatPanel.vue?raw';
import { useCardStore } from '../../stores/cards';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';
import { cardView } from '../card-view-fixtures';

const listChatSessions = vi.fn();
const getChatEntries = vi.fn();
const sendChatMessage = vi.fn();

vi.mock('../../api/client', () => ({
  listChatSessions: (...args: any[]) => listChatSessions(...args),
  getChatEntries: (...args: any[]) => getChatEntries(...args),
  sendChatMessage: (...args: any[]) => sendChatMessage(...args),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));

const CHILD_ZERO_ID = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD_ONE_ID = 'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CHILD_TWO_ID = 'card-cccccccccccccccccccccccccccc';

describe('AnalystChatPanel on-screen children', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    listChatSessions.mockReset();
    getChatEntries.mockReset();
    sendChatMessage.mockReset();
    listChatSessions.mockResolvedValue({ sessions: [{ id: 'analyst:global', role: 'analyst', status: 'active', started_at: '2025-01-01T00:00:00Z' }] });
    getChatEntries.mockResolvedValue({ session: null, entries: [], activity_status: { status: 'inactive', pending_calls: [] } });
    sendChatMessage.mockResolvedValue({ sessionId: 'analyst:global', toolInvocations: [], restart: null });
  });

  it('imports the singular useCardStore symbol from ../../stores/cards', () => {
    expect(analystChatPanelSource).toMatch(/import\s*\{[^}]*\buseCardStore\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/stores\/cards['"]/);
    expect(useCardStore).toBeDefined();
  });

  it('renders children in committed parent children order', async () => {
    const pinia = createPinia();
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [pinia] } });
    const cards = useCardStore();
    cards.hierarchySlicesByParentId = { project: { parent: cardView('project', { children: [CHILD_ONE_ID, CHILD_TWO_ID, CHILD_ZERO_ID], title: 'Parent' }), children: [
      cardView(CHILD_ONE_ID, { title: 'First' }),
      cardView(CHILD_TWO_ID, { title: 'Second' }),
      cardView(CHILD_ZERO_ID, { title: 'Zero' }),
    ] } };
    const workspaceRoute = useWorkspaceRouteStore();
    workspaceRoute.view = 'cards';
    workspaceRoute.entityId = 'project';
    await flushPromises();
    const items = wrapper.findAll('.on-screen-children li').map((item) => item.text());
    expect(items).toEqual([
      `${CHILD_ONE_ID} — First`,
      `${CHILD_TWO_ID} — Second`,
      `${CHILD_ZERO_ID} — Zero`,
    ]);
    wrapper.unmount();
  });

  it('does not render the list outside the cards view', async () => {
    const pinia = createPinia();
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [pinia] } });
    const cards = useCardStore();
    cards.hierarchySlicesByParentId = { project: { parent: cardView('project', { children: [CHILD_ZERO_ID] }), children: [cardView(CHILD_ZERO_ID, { title: 'Zero' })] } };
    const workspaceRoute = useWorkspaceRouteStore();
    workspaceRoute.view = 'dashboard';
    workspaceRoute.entityId = 'project';
    await flushPromises();
    expect(wrapper.find('.on-screen-children').exists()).toBe(false);
    wrapper.unmount();
  });
});
