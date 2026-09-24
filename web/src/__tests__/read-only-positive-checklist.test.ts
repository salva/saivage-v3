import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import cockpitViewSource from '../views/CockpitView.vue?raw';
import sessionViewSource from '../views/SessionView.vue?raw';
import systemViewSource from '../views/SystemView.vue?raw';
import filesViewSource from '../views/FilesView.vue?raw';
import agentsPanelSource from '../components/debug/AgentsPanel.vue?raw';
import doctorPanelSource from '../components/debug/DoctorPanel.vue?raw';
import errorsPanelSource from '../components/debug/ErrorsPanel.vue?raw';
import graphsPanelSource from '../components/debug/GraphsPanel.vue?raw';
import mcpPanelSource from '../components/debug/McpPanel.vue?raw';
import operatorControlPanelSource from '../components/debug/OperatorControlPanel.vue?raw';
import processesPanelSource from '../components/debug/ProcessesPanel.vue?raw';
import statePanelSource from '../components/debug/StatePanel.vue?raw';
import cardFlowHeaderSource from '../components/cockpit/CardFlowHeader.vue?raw';
import cardsTreeSource from '../components/cards/CardsTreeView.vue?raw';
import cardOverviewFacetSource from '../components/cockpit/CardOverviewFacet.vue?raw';
import participantRailSource from '../components/cockpit/ParticipantRail.vue?raw';
import restartDialogSource from '../components/cockpit/RestartServerDialog.vue?raw';
import agentConversationSource from '../components/agents/AgentConversationView.vue?raw';
import debugAgentDetailSource from '../components/agents/DebugAgentDetail.vue?raw';
import analystChatPanelSource from '../components/chat/AnalystChatPanel.vue?raw';
import agentTimelineSource from '../composables/useAgentTimeline.ts?raw';
import CodeBlock from '../components/content/CodeBlock.vue';
import routerSource from '../router.ts?raw';
import appShellSource from '../components/layout/AppShell.vue?raw';

const removedMutationTokens = new RegExp([
  'createCard',
  'updateCard',
  'deleteCard',
  'startProject',
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
  it('keeps representative passive controls on each operator surface', () => {
    const surfaces = [
      cockpitViewSource,
      sessionViewSource,
      systemViewSource,
      filesViewSource,
      agentsPanelSource,
      doctorPanelSource,
      errorsPanelSource,
      graphsPanelSource,
      mcpPanelSource,
      operatorControlPanelSource,
      processesPanelSource,
      statePanelSource,
    ].join('\n');

    // CockpitView: tree expand/collapse, exact selection, and facet navigation remain.
    expect(cockpitViewSource).toContain('@toggle="toggleTreeNode"');
    expect(cockpitViewSource).toContain('@select="selectCard"');
    expect(cockpitViewSource).toContain('facetLink(\'conversations\')');
    expect(cockpitViewSource).not.toContain('view-tab');
    expect(cockpitViewSource).not.toContain('Card Tree');
    const removedCardsFilters = new RegExp([
      ['Search', ' cards'].join(''),
      ['Filter by ', 'status'].join(''),
      ['Filter by ', 'type'].join(''),
      ['Any ', 'status'].join(''),
      ['Any ', 'type'].join(''),
      ['cards', '-filters'].join(''),
    ].join('|'));
    expect(cockpitViewSource).not.toMatch(removedCardsFilters);
    expect(cockpitViewSource).toContain('Loaded branches');

    // The singular route table has no legacy destinations or redirects.
    expect(routerSource).not.toContain('/dashboard');
    expect(routerSource).not.toContain("'debug'");
    expect(routerSource).not.toContain("redirect");
    expect(appShellSource).not.toContain("id: 'timeline'");

    // SessionView: passive scope resolution, back-to-card, and exact reader mount remain.
    expect(sessionViewSource).toContain('getAgentSession');
    expect(sessionViewSource).toContain('Back to card');
    expect(sessionViewSource).toContain(':flow-unavailable="cardContext.unavailable.value"');
    expect(cardFlowHeaderSource).toContain('Card flow unavailable');

    // SystemView: passive section switching, refresh/fetch, and file-browse navigation remain.
    expect(systemViewSource).toContain('@click="setSection(section.id)"');
    expect(systemViewSource).toContain('@refresh="refreshOperatorControl"');
    expect(systemViewSource).not.toContain('timeline-kind-filter');
    expect(systemViewSource).toContain('debugStore.fetchProcesses()');
    expect(processesPanelSource).toContain("emit('browse-log', logEntry.value)");
    expect(operatorControlPanelSource).toContain("emit('refresh')");
    expect(systemViewSource).not.toContain('browseQuarantineItem');

    // FilesView: read-only file refresh, breadcrumb/directory navigation, safe preview, and close remain.
    expect(filesViewSource).toContain('@click="refreshActiveRoot"');
    expect(filesViewSource).toContain("@click=\"goToRoot('meta')\"");
    expect(filesViewSource).toContain("@click=\"goToRoot('output')\"");
    expect(filesViewSource).toContain('@click="openDirectory(crumb.path)"');
    expect(filesViewSource).toContain('fileStore.fetchFileContent(entry.path)');
    expect(filesViewSource).toContain('fileStore.clearViewedFile()');

    // Conversation readers keep passive navigation, expand/collapse, provider metadata toggle.
    expect(agentConversationSource).toContain('timelineControls.expandAll()');
    expect(agentConversationSource).toContain('timelineControls.collapseAll()');
    expect(agentConversationSource).toContain('rawPanelOpen = !rawPanelOpen');
    expect(agentConversationSource).toContain('Provider exchange metadata');
    expect(agentConversationSource).toContain('ConversationTimeline');
    expect(analystChatPanelSource).toContain('ConversationTimeline');
    expect(analystChatPanelSource).toContain('useAgentTimeline');
    expect(agentTimelineSource).toContain('jumpToLatest');
    expect(agentTimelineSource).toContain('unseenCount');
    expect(agentTimelineSource).toContain('autoScrollPaused');
    expect(agentTimelineSource).toContain('toggleAutoScrollPause');
    expect(agentConversationSource).toContain('Jump to latest');
    expect(analystChatPanelSource).toContain('Jump to latest');
    expect(debugAgentDetailSource).toContain('timelineControls.jumpToLatest');
    expect(agentConversationSource).toContain('Pause auto-scroll');
    expect(analystChatPanelSource).toContain('Pause auto-scroll');
    expect(debugAgentDetailSource).toContain('Pause auto-scroll');
    expect(agentTimelineSource).not.toContain('modelLabel');
    expect(agentConversationSource).toContain('useAgentTimeline(entries)');
    expect(debugAgentDetailSource).toContain('useAgentTimeline(entries)');
    expect(analystChatPanelSource).not.toMatch(/state-panel|message-bubble|message-badges|pending-tool|chat-composer|composer-input|primary-btn/);

    // Card flow header, facets, and tree navigation remain read-only positive paths.
    expect(cardFlowHeaderSource).toContain('Possible outcomes');
    expect(cardFlowHeaderSource).not.toContain('@click="activate');
    expect(cardOverviewFacetSource).toContain('Declared records');
    expect(participantRailSource).toContain('Configured node/role');
    expect(restartDialogSource).toContain('RESTART SERVER');
    expect(restartDialogSource).not.toContain('window.prompt');
    expect(cardsTreeSource).toContain("emit('toggle', node.card.id)");
    expect(cardsTreeSource).toContain("emit('select', node.card.id)");
    expect(cardsTreeSource).toContain('node-status');

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
