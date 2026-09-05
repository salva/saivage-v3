<template>
  <div class="debug-layout" data-testid="route-debug">
    <div class="tablist debug-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="pill debug-tab-button"
        :aria-pressed="localActiveTab === tab.id"
        @click="setTab(tab.id)"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="debug-content">
      <StatePanel
        v-if="localActiveTab === 'state'"
        :runtime="runtime"
        :runtime-loaded="runtimeLoaded"
        :runtime-loading="runtimeLoading"
        :runtime-error="runtimeError"
        :runtime-refreshing="runtimeRefreshing"
        :runtime-refresh-error="runtimeRefreshError"
        :current-card-id="currentCardId"
      />
      <OperatorControlPanel
        v-if="localActiveTab === 'operator'"
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
      <ErrorsPanel
        v-if="localActiveTab === 'errors'"
        :errors-loading="errorsLoading"
        :errors-error="errorsError"
        :errors-total="errorsTotal"
        :errors="errors"
        :error-source-entries="errorSourceEntries"
      />
      <AgentsPanel
        v-if="localActiveTab === 'agents'"
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
      <GraphsPanel
        v-if="localActiveTab === 'graphs'"
        :graphs="graphs"
        :graphs-loading="graphsLoading"
        :graphs-refreshing="graphsRefreshing"
        :graphs-error="graphsError"
        :graphs-refresh-error="graphsRefreshError"
        :selected-graph-card-type="selectedGraphCardType"
        :selected-graph="selectedGraph"
        @refresh="refreshGraphs"
        @select-graph="selectGraph"
      />
      <ProcessesPanel
        v-if="localActiveTab === 'processes'"
        :processes-loading="processesLoading"
        :processes-error="processesError"
        :sorted-processes="sortedProcesses"
        :selected-process-id="selectedProcessId"
        @refresh="refreshProcesses"
        @browse-log="browseProcessLog"
      />
      <DoctorPanel
        v-if="localActiveTab === 'doctor'"
        :doctor-status="doctorStatus"
        :doctor-checks="doctorChecks"
        :doctor-issues="doctorIssues"
        :doctor-loading="doctorLoading"
        :doctor-error="doctorError"
        @fetch="fetchDoctor"
      />
      <McpPanel
        v-if="localActiveTab === 'mcp'"
        :servers="mcpServers"
        :loading="mcpLoading"
        :error="mcpError"
        :server-count="mcpServerCount"
        :tool-count="mcpToolCount"
        :total-invocations="mcpTotalInvocations"
        :total-errors="mcpTotalErrors"
        :last-refreshed="mcpLastRefreshed"
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
import DoctorPanel from '../components/debug/DoctorPanel.vue';
import ErrorsPanel from '../components/debug/ErrorsPanel.vue';
import GraphsPanel from '../components/debug/GraphsPanel.vue';
import McpPanel from '../components/debug/McpPanel.vue';
import OperatorControlPanel from '../components/debug/OperatorControlPanel.vue';
import ProcessesPanel from '../components/debug/ProcessesPanel.vue';
import StatePanel from '../components/debug/StatePanel.vue';
import '../components/debug/debug-panels.css';
import { useDebugReadModel } from '../composables/useDebugReadModel';
import { useAgentStore } from '../stores/agents';
import { useDebugStore } from '../stores/debug';
import { useMcpStore } from '../stores/mcp';
import { useRuntimeStore } from '../stores/runtime';
import { useSyncStore } from '../stores/sync';

const debugStore = useDebugStore();
const liveSyncStore = useSyncStore();
const runtimeStore = useRuntimeStore();
const agentStore = useAgentStore();
const mcpStore = useMcpStore();
const route = useRoute();
const router = useRouter();

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

const {
  tabs,
  localActiveTab,
  runtimeStatusLabel,
  currentCardId,
  operatorPanelBusy,
  sortedProcesses,
  errorSourceEntries,
} = useDebugReadModel(debugStore, runtimeStore);

const agentDebugKinds: readonly { id: AgentDebugKind; label: string }[] = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'llmExchange', label: 'Raw LLM Exchange' },
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

watch(
  () => [route.name, route.query.tab, route.params.id] as const,
  () => {
    const tabFromRoute = typeof route.query.tab === 'string' ? route.query.tab : 'state';
    if (tabs.some((tab) => tab.id === tabFromRoute))
      setTabLocal(tabFromRoute as typeof localActiveTab.value);
  },
  { immediate: true },
);

function setTabLocal(tab: typeof localActiveTab.value): void {
  localActiveTab.value = tab;
}

function setTab(tab: typeof localActiveTab.value): void {
  setTabLocal(tab);
  void router.push({ name: 'debug', query: tab === 'state' ? {} : { tab } });
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

let unregisterAgents: (() => void) | null = null;
watch(
  localActiveTab,
  (tab) => {
    if (tab === 'errors') debugStore.fetchErrors().catch(() => {});
    else if (tab === 'processes') debugStore.fetchProcesses().catch(() => {});
    else if (tab === 'graphs' && graphs.value === null) debugStore.fetchGraphs().catch(() => {});
    else if (tab === 'mcp') mcpStore.fetchMcpData().catch(() => {});
  },
  { immediate: true },
);
watch(
  localActiveTab,
  (tab) => {
    if (tab === 'agents' && !unregisterAgents)
      unregisterAgents = liveSyncStore.openAgents((frame) => agentStore.reconcileMembership(frame));
    else if (tab !== 'agents' && unregisterAgents) {
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
.debug-layout {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.debug-tabs {
  display: flex;
  gap: 2px;
  padding: 8px 12px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.debug-content {
  flex: 1;
  overflow-y: auto;
}
</style>
