import { describe, expect, it } from 'vitest';
import source from '../views/DebugView.vue?raw';
import readModelSource from '../composables/useDebugReadModel?raw';
import debugStoreSource from '../stores/debug?raw';

describe('DebugView S06 diagnostic-only integration contract', () => {
  it('exposes a route-owned root and route-body content for browser smoke assertions', () => {
    expect(source).toContain('data-testid="route-debug"');
    expect(source).toContain('debug-tabs');
    expect(source).toContain('Runtime State');
  });

  it('retains diagnostic tabs and refresh controls while removing mutation controls', () => {
    expect(readModelSource).toContain("label: 'State'");
    expect(readModelSource).toContain("label: 'Errors'");
    expect(readModelSource).toContain("label: 'Timeline'");
    expect(readModelSource).toContain("label: 'Processes'");
    expect(readModelSource).toContain("label: 'Graphs'");
    expect(source).toContain('useDebugReadModel');
    expect(source).toContain('@click="refreshOperatorControl"');
    expect(source).toContain('@click="debugStore.fetchProcesses()"');
    expect(source).toContain('DebugGraphDiagram');
    expect(source).toContain('Configuration changes appear only after server restart.');
    expect(source).not.toMatch(/graph.*(?:edit|reload|save)/i);

    expect(source).not.toMatch(/terminateProcess|@click="[^"]*terminate/i);
    expect(source).not.toMatch(/acknowledgeNote|acknowledgeNotification|clearAllNotes|deleteNote|pauseRuntime|resumeRuntime/);
    expect(source).not.toMatch(/NotificationsPanel/);
  });

  it('does not present loaded card slices as a global Debug inventory', () => {
    expect(source).not.toContain('debug-view-card-children');
    expect(source).not.toContain('childrenForCard(card.id)');
    expect(source).not.toContain('cardStatusEntries');
  });

  it('derives core rows from domain owners and performs no copied agent-list read', () => {
    expect(source).toContain('useRuntimeStore');
    expect(source).not.toContain('useCardStore');
    expect(source).toContain('useAgentStore');
    expect(source).toContain('validExplicitAgentSessionId');
    expect(source).toContain('effectiveAgentSessionId');
    expect(source).toContain(':key="`${effectiveAgentSessionId}:${selectedAgentDebugKind}`"');
    expect(debugStoreSource).not.toMatch(/listAgentSessions|getAgentConversation|getAgentLlmExchange/);
    expect(debugStoreSource).toContain('fetchErrors(),');
    expect(debugStoreSource).toContain('fetchTimeline(),');
  });
});
