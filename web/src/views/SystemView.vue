<template>
  <div class="system-route" data-testid="route-system">
    <div class="tablist system-sections" role="tablist" aria-label="System sections">
      <button
        v-for="section in sections"
        :key="section.id"
        class="pill system-section-button"
        :aria-pressed="activeSection === section.id"
        @click="setSection(section.id)"
      >
        {{ section.label }}
      </button>
    </div>

    <div class="system-content">
      <StatePanel
        v-if="activeSection === 'state'"
        :runtime="runtime"
        :runtime-loaded="runtimeLoaded"
        :runtime-loading="runtimeLoading"
        :runtime-error="runtimeError"
        :runtime-refreshing="runtimeRefreshing"
        :runtime-refresh-error="runtimeRefreshError"
        :current-card-id="currentCardId"
        :oversight="oversight"
      />
      <OperatorControlPanel
        v-if="activeSection === 'operator'"
        :runtime="runtime"
        :runtime-loaded="runtimeLoaded"
        :runtime-loading="runtimeLoading"
        :runtime-error="runtimeError"
        :runtime-refresh-error="runtimeRefreshError"
        :runtime-last-fetched-at="runtimeLastFetchedAt"
        :runtime-status-label="runtimeStatusLabel"
        :current-card-id="currentCardId"
        :operator-panel-busy="operatorPanelBusy"
        @refresh="refreshOperatorControl"
      />
      <AgentsPanel
        v-if="activeSection === 'participants'"
        :sessions="sessions"
        :sessions-loaded="sessionsLoaded"
        :sessions-loading="sessionsLoading"
        :sessions-refreshing="sessionsRefreshing"
        :sessions-error="sessionsError"
        :sessions-refresh-error="sessionsRefreshError"
        :sessions-unauthorized="sessionsUnauthorized"
        :effective-agent-session-id="effectiveAgentSessionId"
        :selected-agent-debug-kind="selectedAgentDebugKind"
        :agent-debug-kinds="agentDebugKinds"
        @refresh="refreshAgents"
        @select-session="selectAgentSession"
        @select-kind="selectAgentDebugKind"
      />
      <ErrorsPanel
        v-if="activeSection === 'errors'"
        :errors-loading="errorsLoading"
        :errors-error="errorsError"
        :errors-total="errorsTotal"
        :errors="errors"
        :error-source-entries="errorSourceEntries"
      />
      <ProcessesPanel
        v-if="activeSection === 'processes'"
        :processes-loading="processesLoading"
        :processes-error="processesError"
        :sorted-processes="sortedProcesses"
        :selected-process-id="selectedProcessId"
        @refresh="refreshProcesses"
        @browse-log="browseProcessLog"
      />
      <McpPanel
        v-if="activeSection === 'mcp'"
        :servers="mcpServers"
        :loading="mcpLoading"
        :error="mcpError"
        :server-count="mcpServerCount"
        :tool-count="mcpToolCount"
        :total-invocations="mcpTotalInvocations"
        :total-errors="mcpTotalErrors"
        :last-refreshed="mcpLastRefreshed"
      />
      <EventsPanel
        v-if="activeSection === 'events'"
        :scope="{ cardId: null }"
        test-id="system-events"
      />
      <ProvidersPanel
        v-if="activeSection === 'providers'"
      />
      <ConfigurationPanel
        v-if="activeSection === 'configuration'"
      />
      <ActionsPanel
        v-if="activeSection === 'actions'"
      />
      <GraphsPanel
        v-if="activeSection === 'workflows'"
        :graphs="graphs"
        :global-agents="globalAgents"
        :graphs-loading="graphsLoading"
        :graphs-refreshing="graphsRefreshing"
        :graphs-error="graphsError"
        :graphs-refresh-error="graphsRefreshError"
        :selected-graph-card-type="selectedGraphCardType"
        :selected-graph="selectedGraph"
        @refresh="refreshGraphs"
        @select-graph="selectGraph"
      />
      <DoctorPanel
        v-if="activeSection === 'doctor'"
        :doctor-status="doctorStatus"
        :doctor-checks="doctorChecks"
        :doctor-issues="doctorIssues"
        :doctor-loading="doctorLoading"
        :doctor-error="doctorError"
        @fetch="fetchDoctor"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import type { ConversationSessionId } from '../api/contracts';
import AgentsPanel, { type AgentDebugKind } from '../components/debug/AgentsPanel.vue';
import EventsPanel from '../components/system/EventsPanel.vue';
import ProvidersPanel from '../components/system/ProvidersPanel.vue';
import ConfigurationPanel from '../components/system/ConfigurationPanel.vue';
import ActionsPanel from '../components/system/ActionsPanel.vue';
import DoctorPanel from '../components/debug/DoctorPanel.vue';
import ErrorsPanel from '../components/debug/ErrorsPanel.vue';
import GraphsPanel from '../components/debug/GraphsPanel.vue';
import McpPanel from '../components/debug/McpPanel.vue';
import OperatorControlPanel from '../components/debug/OperatorControlPanel.vue';
import ProcessesPanel from '../components/debug/ProcessesPanel.vue';
import StatePanel from '../components/debug/StatePanel.vue';
import '../components/debug/debug-panels.css';
import { useAgentStore } from '../stores/agents';
import { useDebugStore } from '../stores/debug';
import { selectSortedProcesses, type ErrorSourceEntry } from '../stores/debug-read-model';
import { useMcpStore } from '../stores/mcp';
import { useRuntimeStore } from '../stores/runtime';
import { useSyncStore } from '../stores/sync';

type SystemSectionId = 'state' | 'operator' | 'participants' | 'errors' | 'events' | 'processes' | 'mcp' | 'providers' | 'configuration' | 'workflows' | 'actions' | 'doctor';

const debugStore = useDebugStore();
const liveSyncStore = useSyncStore();
const runtimeStore = useRuntimeStore();
const agentStore = useAgentStore();
const mcpStore = useMcpStore();
const route = useRoute();
const router = useRouter();

const sections: readonly { id: SystemSectionId; label: string }[] = [
  { id: 'state', label: 'State' },
  { id: 'operator', label: 'Operator observation' },
  { id: 'participants', label: 'Participants' },
  { id: 'errors', label: 'Errors' },
  { id: 'events', label: 'Events' },
  { id: 'processes', label: 'Processes' },
  { id: 'mcp', label: 'MCP' },
  { id: 'providers', label: 'Provider availability' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'workflows', label: 'Installed workflows' },
  { id: 'actions', label: 'Actions' },
  { id: 'doctor', label: 'Doctor' },
];

const {
  errors,
  errorsTotal,
  errorsLoading,
  errorsError,
  processesLoading,
  processesError,
  doctorStatus,
  doctorChecks,
  doctorIssues,
  doctorLoading,
  doctorError,
  graphs,
  globalAgents,
  graphsLoading,
  graphsRefreshing,
  graphsError,
  graphsRefreshError,
} = storeToRefs(debugStore);
const {
  runtime,
  loaded: runtimeLoaded,
  loading: runtimeLoading,
  refreshing: runtimeRefreshing,
  error: runtimeError,
  refreshError: runtimeRefreshError,
  lastFetchedAt: runtimeLastFetchedAt,
  oversight,
  currentCardId,
} = storeToRefs(runtimeStore);
const {
  sessions,
  sessionsLoaded,
  sessionsLoading,
  sessionsRefreshing,
  sessionsError,
  sessionsRefreshError,
  sessionsUnauthorized,
} = storeToRefs(agentStore);
const {
  servers: mcpServers,
  loading: mcpLoading,
  error: mcpError,
  serverCount: mcpServerCount,
  toolCount: mcpToolCount,
  totalInvocations: mcpTotalInvocations,
  totalErrors: mcpTotalErrors,
  lastRefreshed: mcpLastRefreshed,
} = storeToRefs(mcpStore);

const runtimeStatusLabel = computed(() => runtimeStore.statusLabel);
const operatorPanelBusy = computed(() => runtimeLoading.value || runtimeRefreshing.value);
const sortedProcesses = computed(() => selectSortedProcesses(debugStore.processes ?? []));
const errorSourceEntries = computed<ErrorSourceEntry[]>(() => {
  const entries: ErrorSourceEntry[] = [];
  for (const [source, list] of debugStore.errorsBySource) entries.push({ source, errors: list });
  return entries;
});

const agentDebugKinds: readonly { id: AgentDebugKind; label: string }[] = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'llmExchange', label: 'Provider exchange metadata' },
];
const explicitAgentSessionId = ref<ConversationSessionId | null>(null);
const selectedAgentDebugKind = ref<AgentDebugKind>('conversation');
const validExplicitAgentSessionId = computed(() =>
  explicitAgentSessionId.value &&
  sessions.value.some((session) => session.id === explicitAgentSessionId.value)
    ? explicitAgentSessionId.value
    : null,
);
const effectiveAgentSessionId = computed(
  () => validExplicitAgentSessionId.value ?? sessions.value[0]?.id ?? null,
);
const selectedGraphCardType = ref<string | null>(null);
const selectedGraph = computed(
  () =>
    graphs.value?.find((graph) => graph.card_type === selectedGraphCardType.value) ??
    graphs.value?.[0] ??
    null,
);
watch(graphs, (value) => {
  if (value?.length && !value.some((graph) => graph.card_type === selectedGraphCardType.value))
    selectedGraphCardType.value = value[0]!.card_type;
});

const selectedProcessId = computed(() =>
  typeof route.query.process === 'string' ? route.query.process : null,
);

const activeSection = ref<SystemSectionId>('state');
watch(
  () => [route.name, route.query.section] as const,
  () => {
    const sectionFromRoute = typeof route.query.section === 'string' ? route.query.section : 'state';
    if (sections.some((section) => section.id === sectionFromRoute))
      activeSection.value = sectionFromRoute as SystemSectionId;
  },
  { immediate: true },
);

function setSection(section: SystemSectionId): void {
  activeSection.value = section;
  void router.push({ name: 'system', query: section === 'state' ? {} : { section } });
}

async function refreshOperatorControl(): Promise<void> {
  await runtimeStore.fetchState().catch(() => {});
}
async function refreshAgents(): Promise<void> {
  await agentStore.fetchSessions();
}
function selectAgentSession(sessionId: ConversationSessionId): void {
  explicitAgentSessionId.value = sessionId;
}
function selectAgentDebugKind(kind: AgentDebugKind): void {
  selectedAgentDebugKind.value = kind;
}
function refreshGraphs(): void {
  void debugStore.fetchGraphs();
}
function selectGraph(cardType: string): void {
  selectedGraphCardType.value = cardType;
}
function refreshProcesses(): void {
  void debugStore.fetchProcesses();
}
function browseProcessLog(path: string): void {
  void router.push({ name: 'files', query: { path } });
}
function fetchDoctor(): void {
  void debugStore.fetchDoctor();
}

watch(
  activeSection,
  (section) => {
    if (section === 'errors') debugStore.fetchErrors().catch(() => {});
    else if (section === 'processes') debugStore.fetchProcesses().catch(() => {});
    else if (section === 'workflows' && graphs.value === null) debugStore.fetchGraphs().catch(() => {});
    else if (section === 'mcp') mcpStore.fetchMcpData().catch(() => {});
  },
  { immediate: true },
);
let unregisterAgents: (() => void) | null = null;
watch(
  activeSection,
  (section) => {
    if (section === 'participants' && !unregisterAgents)
      unregisterAgents = liveSyncStore.openAgents((frame) => agentStore.reconcileMembership(frame));
    else if (section !== 'participants' && unregisterAgents) {
      unregisterAgents();
      unregisterAgents = null;
      agentStore.releaseSessions();
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  unregisterAgents?.();
});
</script>

<style scoped>
.system-route {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.system-sections {
  display: flex;
  gap: 2px;
  padding: 8px 12px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.system-content {
  flex: 1;
  overflow-y: auto;
}
</style>
