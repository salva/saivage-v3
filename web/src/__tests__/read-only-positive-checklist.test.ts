import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import cardsViewSource from '../views/CardsView.vue?raw';
import dashboardViewSource from '../views/DashboardView.vue?raw';
import filesViewSource from '../views/FilesView.vue?raw';
import agentsViewSource from '../views/AgentsView.vue?raw';
import debugViewSource from '../views/DebugView.vue?raw';
import timelineViewSource from '../views/TimelineView.vue?raw';
import cardDetailSource from '../components/cards/CardDetailView.vue?raw';
import cardsTreeSource from '../components/cards/CardsTreeView.vue?raw';
import agentConversationSource from '../components/agents/AgentConversationView.vue?raw';
import analystChatPanelSource from '../components/chat/AnalystChatPanel.vue?raw';
import agentTimelineSource from '../composables/useAgentTimeline.ts?raw';
import CodeBlock from '../components/content/CodeBlock.vue';

const removedMutationTokens = new RegExp([
  'createCard',
  'updateCard',
  'deleteCard',
  'startProject',
  'stopProject',
  'pauseRuntime',
  'resumeRuntime',
  'acknowledgeNotification',
  'terminateProcess',
  'clearAllNotes',
  'deleteNote',
  'acknowledgeNote',
  ['list', 'Notifications'].join(''),
  ['list', 'Notes'].join(''),
  ['fetch', 'Notifications'].join(''),
  ['fetch', 'Notes'].join(''),
  ['Notification', 'Record'].join(''),
  ['Notifications', 'ListResponse'].join(''),
  ['NoteQueue', 'Entry'].join(''),
  ['Notes', 'ListResponse'].join(''),
].join('|'));

describe('read-only positive checklist', () => {
  it('keeps representative passive controls on each operator view', () => {
    const surfaces = [
      cardsViewSource,
      dashboardViewSource,
      filesViewSource,
      agentsViewSource,
      debugViewSource,
    ].join('\n');

    // CardsView: tree expand/collapse and navigation remain; filters, presentation tabs, and duplicate page chrome are intentionally gone.
    expect(cardsViewSource).toContain('@toggle="toggleTreeNode"');
    expect(cardsViewSource).toContain('@select="selectCard"');
    expect(cardsViewSource).not.toContain('Card Tree');
    expect(cardsViewSource).not.toContain('Open Timeline');
    expect(cardsViewSource).not.toContain('view-tab');
    expect(cardsViewSource).not.toContain('placeholder="Search cards..."');
    expect(timelineViewSource).toContain('CardsTimelineView');
    expect(timelineViewSource).not.toContain('Back to Card Tree');

    // DashboardView: runtime refresh and passive navigation links remain while start/stop controls are gone.
    expect(dashboardViewSource).toContain('@click="refreshRuntime"');
    expect(dashboardViewSource).toContain('@click="goToCard(run.card_id)"');
    expect(dashboardViewSource).toContain('@click="goToAgent(currentRun.session_id)"');
    expect(dashboardViewSource).not.toMatch(/runtime-command start-project|runtime-command stop-project/);

    // FilesView: read-only file refresh, breadcrumb/directory navigation, safe preview, and close remain.
    expect(filesViewSource).toContain('@click="refreshActiveRoot"');
    expect(filesViewSource).toContain("@click=\"goToRoot('meta')\"");
    expect(filesViewSource).toContain("@click=\"goToRoot('output')\"");
    expect(filesViewSource).toContain('@click="openDirectory(crumb.path)"');
    expect(filesViewSource).toContain('fileStore.fetchFileContent(entry.path)');
    expect(filesViewSource).toContain('fileStore.clearViewedFile()');

    // AgentsView/AgentConversationView: passive session navigation, expand/collapse, raw toggle, and linked navigation remain.
    expect(agentsViewSource).toContain('@select="selectSession(session.id)"');
    expect(agentsViewSource).toContain('Back to Agents');
    expect(agentConversationSource).toContain('timelineControls.expandAll()');
    expect(agentConversationSource).toContain('timelineControls.collapseAll()');
    expect(agentConversationSource).toContain('rawPanelOpen = !rawPanelOpen');
    expect(agentConversationSource).toContain('ConversationTimeline');
    expect(analystChatPanelSource).toContain('ConversationTimeline');
    expect(analystChatPanelSource).toContain('useAgentTimeline');
    expect(agentTimelineSource).toContain('jumpToLatest');
    expect(agentTimelineSource).toContain('unseenRoundCount');
    expect(agentConversationSource).toContain('Jump to latest');
    expect(analystChatPanelSource).toContain('Jump to latest');
    expect(debugViewSource).toContain('agentDebugTimeline.jumpToLatest');
    expect(agentTimelineSource).toContain('modelLabel');
    expect(agentConversationSource).toContain('useAgentTimeline(entries, activityStatus, sessionModel)');
    expect(debugViewSource).toContain('agentDebugModel');
    expect(analystChatPanelSource).not.toMatch(/state-panel|message-bubble|message-badges|pending-tool|chat-composer|composer-input|primary-btn/);

    // DebugView: passive tab switching, refresh/fetch, filtering, and file-browse navigation remain.
    expect(debugViewSource).toContain('@click="setTab(tab.id)"');
    expect(debugViewSource).toContain('@click="refreshOperatorControl"');
    expect(debugViewSource).toContain('aria-label="Filter timeline event kinds"');
    expect(debugViewSource).toContain('selectedTimelineKinds = []');
    expect(debugViewSource).toContain('debugStore.fetchProcesses()');
    expect(debugViewSource).toContain('browseProcessLog(logEntry.value)');
    expect(debugViewSource).toContain('browseQuarantineItem(entry.quarantine_id)');

    // Card detail and tree navigation remain read-only positive paths.
    expect(cardDetailSource).toContain('CardRecordsSection');
    expect(cardDetailSource).toContain('CardConversationsSection');
    expect(cardDetailSource).toContain('Version history');
    expect(cardDetailSource).toContain('@click="navigateCard(dispatch.targetCardId)"');
    expect(cardsTreeSource).toContain("emit('toggle', node.card.id)");
    expect(cardsTreeSource).toContain("emit('select', node.card.id)");

    expect(surfaces).not.toMatch(removedMutationTokens);
  });

  it('keeps copy operational for read-only code previews', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText } },
    });

    const wrapper = mount(CodeBlock, {
      props: { code: 'read-only artifact', language: 'text', copyable: true },
    });

    await wrapper.find('button.code-block__copy').trigger('click');
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('read-only artifact');
  });
});
