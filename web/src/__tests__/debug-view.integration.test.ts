import { describe, expect, it } from 'vitest';
import source from '../views/DebugView.vue?raw';
import readModelSource from '../composables/useDebugReadModel?raw';
import debugStoreSource from '../stores/debug?raw';
import statePanelSource from '../components/debug/StatePanel.vue?raw';
import operatorPanelSource from '../components/debug/OperatorControlPanel.vue?raw';
import agentsPanelSource from '../components/debug/AgentsPanel.vue?raw';
import graphsPanelSource from '../components/debug/GraphsPanel.vue?raw';
import processesPanelSource from '../components/debug/ProcessesPanel.vue?raw';
import doctorPanelSource from '../components/debug/DoctorPanel.vue?raw';
import errorsPanelSource from '../components/debug/ErrorsPanel.vue?raw';
import mcpPanelSource from '../components/debug/McpPanel.vue?raw';
import debugAgentDetailSource from '../components/agents/DebugAgentDetail.vue?raw';
import sharedPanelStyles from '../components/debug/debug-panels.css?raw';

describe('DebugView S06 diagnostic-only integration contract', () => {
  it('exposes a route-owned root and route-body content for browser smoke assertions', () => {
    expect(source).toContain('data-testid="route-debug"');
    expect(source).toContain('debug-tabs');
    expect(source).toContain("v-if=\"localActiveTab === 'state'\"");
    expect(statePanelSource).toContain('Runtime State');
    expect(statePanelSource).toContain('No live runtime.');
    expect(statePanelSource).toContain('!runtimeLoaded');
    expect(operatorPanelSource).toContain('v-if="runtimeLoaded && !runtime"');
    expect(operatorPanelSource).not.toContain('v-if="!runtime"');
    expect(operatorPanelSource).not.toMatch(/\(stale\)|operatorDataFreshness|runtime state is not initialized|Runtime diagnostics are unavailable|Run the project/);
  });

  it('retains diagnostic tabs and refresh controls while removing mutation controls', () => {
    expect(readModelSource).toContain("label: 'State'");
    expect(readModelSource).toContain("label: 'Errors'");
    expect(readModelSource).not.toContain("label: 'Timeline'");
    expect(readModelSource).toContain("label: 'Processes'");
    expect(readModelSource).toContain("label: 'Graphs'");
    expect(source).toContain('useDebugReadModel');
    expect(source).toContain('@refresh="refreshOperatorControl"');
    expect(source).toContain('@refresh="refreshProcesses"');
    expect(graphsPanelSource).toContain('DebugGraphDiagram');
    expect(graphsPanelSource).toContain('Configuration changes appear only after server restart.');
    expect(graphsPanelSource).not.toMatch(/graph.*(?:edit|reload|save)/i);

    expect(processesPanelSource).not.toMatch(/terminateProcess|@click="[^"]*terminate/i);
    expect([source, operatorPanelSource, processesPanelSource].join('\n')).not.toMatch(/acknowledgeNote|acknowledgeNotification|clearAllNotes|deleteNote|pauseRuntime|resumeRuntime/);
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
    expect(agentsPanelSource).toContain(':key="`${effectiveAgentSessionId}:${selectedAgentDebugKind}`"');
    expect(debugStoreSource).not.toMatch(/listAgentSessions|getAgentConversation|getAgentLlmExchange/);
    expect(debugStoreSource).toContain('async function fetchErrors()');
    expect(debugStoreSource).not.toContain('async function fetchTimeline()');
    expect(debugStoreSource).not.toContain('refreshObservability');
    expect(source).not.toContain('startPolling');
  });

  it('keeps panel presentation separate from route, store, and request ownership', () => {
    const panelSources = import.meta.glob('../components/debug/*Panel.vue', {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>;
    expect(Object.keys(panelSources)).toHaveLength(8);
    for (const panelSource of Object.values(panelSources)) {
      expect(panelSource).not.toMatch(/useRoute|useRouter|use\w+Store|storeToRefs/);
    }
    const monoOwners = Object.entries(panelSources)
      .filter(([, panelSource]) => /\.mono\s*\{/.test(panelSource))
      .map(([path]) => path.split('/').at(-1))
      .sort();
    expect(monoOwners).toEqual([
      'AgentsPanel.vue',
      'OperatorControlPanel.vue',
      'ProcessesPanel.vue',
      'StatePanel.vue',
    ]);
    expect(source).toContain("import '../components/debug/debug-panels.css';");
    expect(sharedPanelStyles).not.toMatch(/\.mono\s*\{/);
    expect(errorsPanelSource).toContain("import type { DebugErrorItem } from '../../stores/debug-read-model';");
    expect(errorsPanelSource).toContain('errorsTotal === 0 && errors.length === 0');
    expect(errorsPanelSource).not.toContain('DebugErrorRecord');
    expect(doctorPanelSource).toContain('class="doctor-check-sep"');
    expect(doctorPanelSource).not.toContain('class="mcp-sep"');
    expect(doctorPanelSource.match(/\.doctor-check-sep\s*\{/g)).toHaveLength(1);
    expect(mcpPanelSource).toContain('class="mcp-sep"');
    expect(mcpPanelSource).not.toContain('doctor-check-sep');
    expect(mcpPanelSource.match(/\.mcp-sep\s*\{/g)).toHaveLength(1);
    const doctorSeparatorRule = doctorPanelSource
      .match(/\.doctor-check-sep\s*\{([^}]+)\}/)?.[1]
      .replace(/\s+/g, ' ')
      .trim();
    const mcpSeparatorRule = mcpPanelSource
      .match(/\.mcp-sep\s*\{([^}]+)\}/)?.[1]
      .replace(/\s+/g, ' ')
      .trim();
    expect(doctorSeparatorRule).toBe(mcpSeparatorRule);
    expect(debugAgentDetailSource).toMatch(/\.mono\s*\{/);
    expect(debugAgentDetailSource).not.toMatch(/\.sv-fetch-btn\s*\{/);
  });
});
