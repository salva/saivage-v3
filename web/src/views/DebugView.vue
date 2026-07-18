<template>
  <div class="debug-layout" data-testid="route-debug">
    <div class="tablist debug-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="pill debug-tab-button"
        :aria-pressed="localActiveTab === tab.id"
        @click="setTab(tab.id)"
      >{{ tab.label }}</button>
    </div>

    <div class="debug-content">
      <div v-if="localActiveTab === 'state'" class="debug-tab-content">
          <section class="debug-section" data-testid="debug-runtime-state">
            <h4 class="debug-section-title">Runtime State</h4>
            <ViewState v-if="runtimeLoading" state="loading" title="Loading runtime state..." />
            <ViewState v-else-if="runtimeError" state="error" title="Failed to load runtime state" :message="runtimeError" />
            <StatusBanner v-if="runtimeRefreshing" tone="stale" message="Refreshing runtime state…" />
            <StatusBanner v-else-if="runtimeRefreshError" tone="warning" :message="runtimeRefreshError" />
            <div v-if="runtime" class="debug-grid">
              <div class="debug-grid-item"><span class="dg-key">Status:</span><span class="dg-value">{{ runtime.status }}</span></div>
              <div class="debug-grid-item"><span class="dg-key">PID:</span><span class="dg-value">{{ runtime.pid }}</span></div>
              <div class="debug-grid-item"><span class="dg-key">Started:</span><span class="dg-value">{{ fmtDate(runtime.started_at) }}</span></div>
              <div class="debug-grid-item"><span class="dg-key">Current Card:</span><span class="dg-value mono">{{ currentCardId || 'none' }}</span></div>
              <div class="debug-grid-item"><span class="dg-key">Agent Session:</span><span class="dg-value mono">{{ currentAgentSessionId || 'none' }}</span></div>
            </div>
            <ViewState v-else state="empty" title="No runtime state." />
          </section>

      </div>

      <div v-if="localActiveTab === 'operator'" class="debug-tab-content">
        <section class="debug-section">
          <div class="debug-section-header operator-header">
            <div>
              <h4 class="debug-section-title">Runtime Diagnostics</h4>
              <p class="operator-subtitle">Inspect runtime state here. Ask the Analyst to Run, Pause, or Shutdown the runtime; use Dashboard for run and activation observability, command errors, and recovery state.</p>
            </div>
            <div class="operator-actions-inline">
              <button class="sv-fetch-btn" :disabled="operatorPanelBusy" @click="refreshOperatorControl">Refresh</button>
            </div>
          </div>

          <div v-if="runtimeLastFetchedAt" class="operator-freshness" role="status">
            Last refreshed {{ fmtDate(runtimeLastFetchedAt) }}
            <span v-if="operatorDataFreshnessLabel === 'stale'">(stale)</span>
          </div>
          <div v-else class="operator-freshness" role="status">Not refreshed yet.</div>

          <ViewState v-if="runtimeLoading && !runtime" state="loading" title="Loading runtime control state..." />
          <ViewState v-else-if="runtimeError && !runtime" state="error" title="Failed to load runtime state" :message="runtimeError" />
          <div v-else class="operator-runtime-card">
            <div class="operator-runtime-summary">
              <div class="debug-grid-item"><span class="dg-key">Status:</span><StatusBadge :status="statusForRuntimeStatus(runtimeStatusLabel)" /></div>
              <div class="debug-grid-item"><span class="dg-key">Current Card:</span><span class="dg-value mono">{{ currentCardId || 'none' }}</span></div>
              <div class="debug-grid-item"><span class="dg-key">Agent Session:</span><span class="dg-value mono">{{ currentAgentSessionId || 'none' }}</span></div>
            </div>

            <StatusBanner v-if="runtimeRefreshError" tone="warning" :message="runtimeRefreshError" />
            <ViewState v-if="!runtime" state="empty" title="Runtime state is unavailable." message="Ask the Analyst to Run the project or open Dashboard to inspect recovery state." />

            <div class="operator-runtime-guidance" role="note">
              DebugView is diagnostic-only. Lifecycle changes are Analyst-owned; Dashboard owns command errors, root runs, child activation edges, and recovery state.
            </div>

            <div v-if="!runtime" class="operator-help-text">Runtime diagnostics are unavailable because runtime state is not initialized. Ask the Analyst to Run the project or open Dashboard to inspect recovery state.</div>
          </div>
        </section>


        <section class="debug-section">
          <div class="debug-section-header operator-header">
            <div>
              <h4 class="debug-section-title">Actionable runtime issues</h4>
              <p class="operator-subtitle">Tool and runtime precondition failures are reported in Dashboard with next-action guidance.</p>
            </div>
          </div>
          <ViewState state="empty" title="Open Dashboard for command errors, activation failures, and recovery state." />
        </section>

      </div>

      <div v-if="localActiveTab === 'errors'" class="debug-tab-content">
        <ViewState v-if="loading" state="loading" title="Loading errors..." />
        <ViewState v-else-if="error" state="error" title="Failed to load" :message="error" />
        <ViewState v-else-if="errorsTotal === 0 && errors.length === 0" state="empty" title="No errors recorded." />
        <div v-else class="errors-list">
          <div v-for="entry in errorSourceEntries" :key="entry.source" class="error-source-group">
            <h4 class="error-source-title">{{ entry.source }} ({{ entry.errors.length }})</h4>
            <div v-for="err in entry.errors" :key="err.timestamp + err.message" class="error-item" :class="'sev-' + err.severity">
              <div class="error-header">
                <span class="error-severity-badge" :class="'sev-' + err.severity">{{ err.severity }}</span>
                <span class="error-type">{{ err.type }}</span>
                <span class="error-time">{{ fmtDate(err.timestamp) }}</span>
              </div>
              <div class="error-message">{{ err.message }}</div>
              <CodeBlock v-if="err.details" :code="err.details" language="text" copyable wrap />
            </div>
          </div>
        </div>
      </div>

      <div v-if="localActiveTab === 'timeline'" class="debug-tab-content">
        <ViewState v-if="loading" state="loading" title="Loading timeline..." />
        <ViewState v-else-if="error" state="error" title="Failed to load" :message="error" />
        <template v-else>
          <div class="timeline-filter">
            <label class="timeline-filter-label" for="timeline-kind-filter">Event kinds</label>
            <select id="timeline-kind-filter" v-model="selectedTimelineKinds" class="timeline-filter-select" multiple aria-label="Filter timeline event kinds">
              <option v-for="kind in timelineKindOptions" :key="kind" :value="kind">{{ kind }}</option>
            </select>
            <span class="timeline-filter-help">No selection shows all event kinds.</span>
            <button v-if="selectedTimelineKinds.length > 0" class="filter-chip" @click="selectedTimelineKinds = []">Show all</button>
          </div>
          <ViewState v-if="filteredTimeline.length === 0" state="empty" title="No timeline events." />
          <div v-else class="timeline-list">
            <div v-for="event in filteredTimeline" :key="timelineKey(event)" class="tl-event">
              <span class="tl-event-type">{{ formatEventKind(event.kind) }}</span>
              <span v-if="event.card_id" class="tl-event-card mono">Card: {{ event.card_id }}</span>
              <span v-if="event.goal_id" class="tl-event-card mono">Goal: {{ event.goal_id }}</span>
              <span v-if="event.session_id" class="tl-event-card mono">Session: {{ event.session_id }}</span>
              <span class="tl-event-time">{{ fmtDate(event.timestamp) }}</span>
              <CodeBlock v-if="Object.keys(timelineDetails(event)).length" :code="formatJson(timelineDetails(event))" language="json" copyable />
            </div>
          </div>
        </template>
      </div>

      <div v-if="localActiveTab === 'agents'" class="debug-tab-content">
        <section class="debug-section">
          <div class="debug-section-header operator-header">
            <div>
              <h4 class="debug-section-title">Agent Conversations</h4>
              <p class="operator-subtitle">Segment-backed conversations from the operator API, with raw tool-delivery and LLM exchange ledgers where available.</p>
            </div>
            <div class="operator-actions-inline">
              <button class="sv-fetch-btn" :disabled="sessionsLoading || sessionsRefreshing" @click="agentStore.fetchSessions">Refresh</button>
            </div>
          </div>

          <StatusBanner v-if="sessionsRefreshError" tone="warning" :message="sessionsRefreshError" />
          <StatusBanner v-if="sessionsRefreshing" tone="stale" message="Refreshing agent sessions…" />
          <ViewState v-if="sessionsLoading" state="loading" title="Loading agent conversations..." />
          <ViewState v-else-if="sessionsUnauthorized" state="unauthorized" title="Agent sessions unavailable" message="Provide a valid API token to load agent sessions." />
          <ViewState v-else-if="sessionsError" state="error" title="Failed to load agent conversations" :message="sessionsError" />
          <ViewState v-else-if="sessionsLoaded && sessions.length === 0" state="empty" title="No agent sessions" />
          <div v-else class="agent-debug-layout">
            <aside class="agent-debug-sidebar" aria-label="Persisted agent sessions">
              <button
                v-for="session in sessions"
                :key="session.id"
                type="button"
                class="agent-debug-session"
                :class="{ selected: effectiveAgentSessionId === session.id }"
                @click="explicitAgentSessionId = session.id"
              >
                <span class="agent-debug-session-id mono">{{ session.id }}</span>
                <span class="agent-debug-session-meta">{{ session.role }} · {{ session.status }}</span>
              </button>
            </aside>
            <div>
              <div class="agent-debug-toolbar">
                <button
                  v-for="kind in agentDebugKinds"
                  :key="kind.id"
                  type="button"
                  class="pill debug-tab-button"
                  :aria-pressed="selectedAgentDebugKind === kind.id"
                  @click="selectedAgentDebugKind = kind.id"
                >{{ kind.label }}</button>
              </div>
              <DebugAgentDetail
                v-if="effectiveAgentSessionId"
                :key="`${effectiveAgentSessionId}:${selectedAgentDebugKind}`"
                :session-id="effectiveAgentSessionId"
                :kind="selectedAgentDebugKind"
              />
            </div>
          </div>
        </section>
      </div>

      <div v-if="localActiveTab === 'mcp'" class="debug-tab-content">
        <ViewState v-if="mcpStore.loading" state="loading" title="Loading MCP tools..." />
        <ViewState v-else-if="mcpStore.error" state="error" title="Failed to load" :message="mcpStore.error" />
        <ViewState v-else-if="mcpStore.serverCount === 0" state="empty" title="No MCP servers configured or running." />
        <div v-else class="mcp-content">
          <section class="debug-section">
            <h4 class="debug-section-title">Summary</h4>
            <div class="debug-grid">
              <div class="debug-grid-item"><span class="dg-key">Servers:</span><span class="dg-value">{{ mcpStore.serverCount }}</span></div>
              <div class="debug-grid-item"><span class="dg-key">Tools:</span><span class="dg-value">{{ mcpStore.toolCount }}</span></div>
              <div class="debug-grid-item"><span class="dg-key">Invocations:</span><span class="dg-value">{{ mcpStore.totalInvocations }} ({{ mcpStore.totalErrors }} errors)</span></div>
              <div v-if="mcpStore.lastRefreshed" class="debug-grid-item"><span class="dg-key">Last Refreshed:</span><span class="dg-value">{{ fmtDate(mcpStore.lastRefreshed) }}</span></div>
            </div>
          </section>
          <section v-for="server in mcpStore.servers" :key="server.name" class="debug-section">
            <h4 class="debug-section-title mcp-server-title">
              <span class="mcp-server-name">{{ server.name }}</span>
              <span class="mcp-server-badge" :class="'mcp-status-' + server.status">{{ server.status }}</span>
              <span class="mcp-sep" aria-hidden="true">·</span>
              <span class="mcp-server-transport">{{ server.transport }}</span>
              <span class="mcp-sep" aria-hidden="true">·</span>
              <span class="mcp-tool-count">{{ server.toolCount }} tools</span>
            </h4>
            <ViewState v-if="server.tools.length === 0" state="empty" title="No tools discovered." />
            <div v-for="tool in server.tools" :key="tool.name" class="mcp-tool-card">
              <div class="mcp-tool-name-row">
                <span class="mcp-tool-name">{{ tool.name }}</span>
                <span class="mcp-sep" aria-hidden="true">·</span>
                <span class="mcp-tool-desc">{{ tool.description || 'No description' }}</span>
              </div>
              <div class="mcp-tool-stats">
                <span class="mcp-stat-item" title="Total invocations"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1"/><line x1="6" y1="3" x2="6" y2="7" stroke="currentColor" stroke-width="1"/><line x1="4" y1="9" x2="8" y2="9" stroke="currentColor" stroke-width="1"/></svg>{{ tool.stats.total }}</span>
                <span class="mcp-stat-item mcp-stat-success" title="Successful invocations">✓ {{ tool.stats.success }}</span>
                <span class="mcp-stat-item mcp-stat-error" title="Failed invocations">✗ {{ tool.stats.error }}</span>
                <span v-if="tool.stats.lastInvokedAt" class="mcp-stat-item mcp-stat-time" title="Last invoked">{{ fmtDate(tool.stats.lastInvokedAt) }}</span>
              </div>
            </div>
          </section>
          <section v-if="Object.keys(mcpStore.invocationStats).length > 0" class="debug-section">
            <h4 class="debug-section-title">All Invocation Stats</h4>
            <div class="mcp-stats-table">
              <div class="mcp-stats-header">
                <span class="mcp-stats-cell">Key</span>
                <span class="mcp-stats-cell">Total</span>
                <span class="mcp-stats-cell">Success</span>
                <span class="mcp-stats-cell">Error</span>
                <span class="mcp-stats-cell">Last</span>
              </div>
              <div v-for="(stats, key) in mcpStore.invocationStats" :key="key" class="mcp-stats-row">
                <span class="mcp-stats-cell mono">{{ key }}</span>
                <span class="mcp-stats-cell">{{ stats.total }}</span>
                <span class="mcp-stats-cell mcp-stat-success">{{ stats.success }}</span>
                <span class="mcp-stats-cell mcp-stat-error">{{ stats.error }}</span>
                <span class="mcp-stats-cell mcp-stat-time">{{ stats.lastInvokedAt ? fmtDate(stats.lastInvokedAt) : '-' }}</span>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div v-if="localActiveTab === 'processes'" class="debug-tab-content">
        <div class="debug-section-header operator-header">
          <div>
            <h4 class="debug-section-title">Processes</h4>
            <p class="operator-subtitle">Inspect Saivage-managed process records using redacted commands and contained log references.</p>
          </div>
          <div class="operator-actions-inline">
            <button class="sv-fetch-btn" :disabled="processesLoading" @click="debugStore.fetchProcesses()">Refresh</button>
          </div>
        </div>

        <ViewState v-if="processesLoading" state="loading" title="Loading processes..." />
        <ViewState v-else-if="processesError" state="error" title="Failed to load" :message="processesError" />
        <ViewState v-else-if="processes.length === 0" state="empty" title="No Saivage-managed processes found." />
        <div v-else class="processes-list">
          <div v-for="proc in sortedProcesses" :key="proc.id" class="process-card" :class="{ selected: selectedProcessId === proc.id }">
            <div class="process-header">
              <span class="process-id mono">{{ proc.id }}</span>
              <span class="process-status-badge" :class="'ps-' + proc.status">{{ proc.status }}</span>
              <span class="process-time">Started {{ fmtDate(proc.started_at) }}</span>
            </div>
            <div class="process-details">
              <div class="pd-row"><span class="pd-key">Command:</span><span class="pd-value mono wrap">{{ proc.command }}</span></div>
              <div class="pd-row"><span class="pd-key">Card:</span><span class="pd-value mono">{{ proc.card_id }}</span></div>
              <div class="pd-row"><span class="pd-key">Session:</span><span class="pd-value mono">{{ proc.session_id || 'none' }}</span></div>
              <div class="pd-row"><span class="pd-key">Owner kind:</span><span class="pd-value mono">{{ proc.owner_kind || 'unknown' }}</span></div>
              <div class="pd-row"><span class="pd-key">Owner id:</span><span class="pd-value mono">{{ proc.owner_id || 'unknown' }}</span></div>
              <div class="pd-row"><span class="pd-key">Working directory:</span><span class="pd-value mono wrap">{{ proc.cwd || 'Unavailable or unsafe to display' }}</span></div>
              <div v-if="proc.ended_at" class="pd-row"><span class="pd-key">Ended:</span><span class="pd-value">{{ fmtDate(proc.ended_at) }}</span></div>
              <div class="pd-row"><span class="pd-key">Exit code:</span><span class="pd-value mono">{{ proc.exit_code ?? '-' }}</span></div>
              <div v-if="proc.timed_out" class="pd-row"><span class="pd-key">Timed out:</span><span class="pd-value">Yes</span></div>
            </div>

            <div class="process-logs">
              <div class="process-subtitle">Logs</div>
              <div v-if="!hasProcessLogs(proc)" class="process-empty-note">No safe log references are available for this process.</div>
              <div v-else>
                <div v-for="logEntry in processLogEntries(proc)" :key="logEntry.key" class="pd-row">
                  <span class="pd-key">{{ logEntry.label }}:</span>
                  <span v-if="logEntry.value" class="pd-value mono wrap">{{ logEntry.value }} <button class="process-link-button" @click="browseProcessLog(logEntry.value)">Browse</button></span>
                  <span v-else class="pd-value">Not available</span>
                </div>
              </div>
            </div>


          </div>
        </div>
      </div>

      <div v-if="localActiveTab === 'supervision'" class="debug-tab-content">
        <section class="debug-section">
          <div class="debug-section-header"><h4 class="debug-section-title">Doctor Diagnostics</h4><button class="sv-fetch-btn" :disabled="doctorLoading" @click="debugStore.fetchDoctor()">Fetch</button></div>
          <ViewState v-if="doctorLoading" state="loading" title="Running diagnostics..." />
          <ViewState v-else-if="doctorError" state="error" title="Failed to load" :message="doctorError" />
          <ViewState v-else-if="doctorStatus === null && doctorChecks.length === 0" state="empty" title="No diagnostics run yet." message="Click Fetch to check card/index consistency." />
          <template v-else>
            <div class="doctor-status-banner" :class="doctorStatus === 'ok' ? 'doctor-ok' : 'doctor-issues'"><span class="doctor-status-icon">{{ doctorStatus === 'ok' ? '✓' : '⚠' }}</span><span class="doctor-status-text">{{ doctorStatus === 'ok' ? 'All checks passed' : 'Issues found' }} ({{ doctorChecks.length }} checks)</span></div>
            <div class="doctor-checks-list"><div v-for="check in doctorChecks" :key="check.name" class="doctor-check-item" :class="check.passed ? 'check-passed' : 'check-failed'"><span class="check-icon">{{ check.passed ? '✓' : '✗' }}</span><div class="check-body"><span class="check-name">{{ check.name }}</span><span v-if="check.details" class="mcp-sep" aria-hidden="true">·</span><span v-if="check.details" class="check-details">{{ check.details }}</span></div></div></div>
            <div v-if="doctorIssues.length > 0" class="doctor-issues"><h5 class="doctor-issues-title">Issues ({{ doctorIssues.length }})</h5><div v-for="(issue, idx) in doctorIssues" :key="idx" class="doctor-issue-item" :class="'issue-' + issue.severity"><span class="issue-severity-badge" :class="'iss-' + issue.severity">{{ issue.severity }}</span><span class="issue-message">{{ issue.message }}</span></div></div>
          </template>
        </section>

        <section class="debug-section">
          <div class="debug-section-header"><h4 class="debug-section-title">Content Supervision</h4><button class="sv-fetch-btn" :disabled="supervisionLoading" @click="debugStore.fetchSupervision()">Fetch</button></div>
          <ViewState v-if="supervisionLoading" state="loading" title="Loading supervision data..." />
          <ViewState v-else-if="supervisionError" state="error" title="Failed to load" :message="supervisionError" />
          <ViewState v-else-if="supervisionStats === null" state="empty" title="No supervision data loaded yet." message="Click Fetch to load." />
          <template v-else>
            <div class="sv-stats-grid"><div class="sv-stat-card sv-stat-total"><span class="sv-stat-num">{{ supervisionStats.total }}</span><span class="sv-stat-label">Total Reviews</span></div><div class="sv-stat-card sv-stat-blocked"><span class="sv-stat-num">{{ supervisionStats.blocked }}</span><span class="sv-stat-label">Blocked</span></div><div class="sv-stat-card sv-stat-passed"><span class="sv-stat-num">{{ supervisionStats.passed }}</span><span class="sv-stat-label">Passed</span></div><div class="sv-stat-card sv-stat-sanitized"><span class="sv-stat-num">{{ supervisionStats.sanitized }}</span><span class="sv-stat-label">Sanitized</span></div></div>
            <div v-if="Object.keys(supervisionStats.byRisk).length" class="sv-sub-section"><h5 class="sv-sub-title">By Risk</h5><div class="sv-pills"><span v-for="(count, risk) in supervisionStats.byRisk" :key="risk" class="sv-pill" :class="'risk-' + risk">{{ risk }}: {{ count }}</span></div></div>
            <div v-if="Object.keys(supervisionStats.bySourceKind).length" class="sv-sub-section"><h5 class="sv-sub-title">By Source</h5><div class="sv-pills"><span v-for="(count, kind) in supervisionStats.bySourceKind" :key="kind" class="sv-pill sv-pill-kind">{{ kind }}: {{ count }}</span></div></div>
            <div v-if="supervisionReviews.length > 0" class="sv-sub-section"><h5 class="sv-sub-title">Recent Reviews ({{ supervisionReviews.length }})</h5><div class="sv-review-list"><div v-for="review in supervisionReviews.slice(0, 20)" :key="review.id" class="sv-review-item" :class="'sv-review-' + review.status"><span class="sv-review-status-badge" :class="'sv-st-' + review.status">{{ review.status }}</span><div class="sv-review-body"><span class="sv-review-summary">{{ review.summary }}</span><div class="sv-review-meta"><span class="sv-review-source">{{ review.source_ref }}</span><span class="sv-review-risk" :class="'risk-' + review.risk">{{ review.risk }}</span><span class="sv-review-time">{{ fmtDate(review.created_at) }}</span></div></div></div></div></div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useDebugStore } from '../stores/debug';
import { useLiveSyncStore } from '../stores/liveSync';
import { useRuntimeStore } from '../stores/runtime';
import { useAgentStore } from '../stores/agents';
import type { ConversationSessionId } from '../api/contracts';
import { useDebugReadModel } from '../composables/useDebugReadModel';
import { formatTimestamp, isRecentTimestamp } from '../utils/timestamp';
import { redactObservabilityValue } from '../utils/observabilityRedaction';
import { useMcpStore } from '../stores/mcp';
import { formatJson } from '../utils/format-json';
import CodeBlock from '../components/content/CodeBlock.vue';
import DebugAgentDetail from '../components/agents/DebugAgentDetail.vue';
import ViewState from '../components/ui/ViewState.vue';
import StatusBanner from '../components/ui/StatusBanner.vue';
import StatusBadge from '../components/ui/StatusBadge.vue';
import { statusForRuntimeStatus } from '../utils/status';
import { selectOperatorDataFreshnessLabel } from '../stores/debug-read-model';
import type { DebugTimelineEvent, ProcessView } from '../types/view-models';

const debugStore = useDebugStore();
const liveSyncStore = useLiveSyncStore();
const runtimeStore = useRuntimeStore();
const agentStore = useAgentStore();
const mcpStore = useMcpStore();
const route = useRoute();
const router = useRouter();
const {
  errors, errorsTotal,
  loading, error,
  processes, processesLoading, processesError,
  doctorStatus, doctorChecks, doctorIssues, doctorLoading, doctorError,
  supervisionReviews, supervisionStats,
  supervisionLoading, supervisionError,
} = storeToRefs(debugStore);
const {
  runtime, loading: runtimeLoading, refreshing: runtimeRefreshing,
  error: runtimeError, refreshError: runtimeRefreshError, lastFetchedAt: runtimeLastFetchedAt,
} = storeToRefs(runtimeStore);
const {
  sessions, sessionsLoaded, sessionsLoading, sessionsRefreshing,
  sessionsError, sessionsRefreshError, sessionsUnauthorized,
} = storeToRefs(agentStore);

const {
  tabs,
  localActiveTab,
  selectedTimelineKinds,
  runtimeStatusLabel,
  currentCardId,
  currentAgentSessionId,
  operatorPanelBusy,
  sortedProcesses,
  timelineKindOptions,
  filteredTimeline,
  errorSourceEntries,
} = useDebugReadModel(debugStore, runtimeStore);

const operatorDataFreshnessLabel = computed(() => selectOperatorDataFreshnessLabel(runtimeLastFetchedAt.value));
async function refreshOperatorControl(): Promise<void> { await runtimeStore.fetchState().catch(() => {}); }

type AgentDebugKind = 'conversation' | 'llmExchange';
const agentDebugKinds: Array<{ id: AgentDebugKind; label: string }> = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'llmExchange', label: 'Raw LLM Exchange' },
];
const explicitAgentSessionId = ref<ConversationSessionId | null>(null);
const selectedAgentDebugKind = ref<AgentDebugKind>('conversation');
const validExplicitAgentSessionId = computed(() =>
  explicitAgentSessionId.value && sessions.value.some((session) => session.id === explicitAgentSessionId.value)
    ? explicitAgentSessionId.value
    : null,
);
const effectiveAgentSessionId = computed(() => validExplicitAgentSessionId.value ?? sessions.value[0]?.id ?? null);

const selectedProcessId = computed(() => {
  if (route.name === 'process-detail' && typeof route.params.id === 'string') return route.params.id;
  return typeof route.query.process === 'string' ? route.query.process : null;
});

watch(() => [route.name, route.query.tab, route.params.id] as const, () => {
  const tabFromRoute = route.name === 'process-detail' ? 'processes' : typeof route.query.tab === 'string' ? route.query.tab : 'state';
  if (tabs.some((tab) => tab.id === tabFromRoute)) setTabLocal(tabFromRoute as typeof localActiveTab.value);
}, { immediate: true });

function setTabLocal(tab: typeof localActiveTab.value): void {
  localActiveTab.value = tab;
  if (tab === 'errors') debugStore.fetchErrors().catch(() => {});
  else if (tab === 'timeline') debugStore.fetchTimeline().catch(() => {});
  else if (tab === 'processes') debugStore.fetchProcesses().catch(() => {});
  else if (tab === 'supervision') { debugStore.fetchDoctor().catch(() => {}); debugStore.fetchSupervision().catch(() => {}); }
  else if (tab === 'mcp') mcpStore.fetchMcpData().catch(() => {});
}

function setTab(tab: typeof localActiveTab.value): void {
  setTabLocal(tab);
  void router.push({ name: 'debug', query: tab === 'state' ? {} : { tab } });
}
function browseProcessLog(path: string): void { router.push({ name: 'files', query: { path } }); }
function processLogEntries(proc: ProcessView): Array<{ key: string; label: string; value: string | null }> { return [{ key: 'stdout', label: 'Stdout', value: proc.logs.stdout }, { key: 'stderr', label: 'Stderr', value: proc.logs.stderr }]; }
function hasProcessLogs(proc: ProcessView): boolean { return processLogEntries(proc).some((entry) => Boolean(entry.value)); }

function fmtDate(ts: string): string { return formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute'); }
function formatEventKind(kind: string): string { return kind.replace(/_/g, ' '); }
function timelineKey(event: DebugTimelineEvent): string { return String(event.id || `${event.timestamp}:${event.kind}:${event.card_id || event.goal_id || event.session_id || ''}`); }
function timelineDetails(event: DebugTimelineEvent): Record<string, unknown> { const details: Record<string, unknown> = {}; for (const [key, value] of Object.entries(event)) { if (['id', 'kind', 'timestamp', 'card_id', 'goal_id', 'session_id'].includes(key)) continue; if (value === undefined || value === null) continue; details[key] = value; } return redactObservabilityValue(details); }

let unregisterTimeline: (() => void) | null = null;
let unregisterProcesses: (() => void) | null = null;
onMounted(async () => {
  unregisterTimeline = liveSyncStore.registerResource({ resource: 'timeline', scope: 'active', refetch: debugStore.refetchTimeline });
  unregisterProcesses = liveSyncStore.registerResource({ resource: 'processes', scope: 'active', refetch: debugStore.refetchProcesses });
  await debugStore.fetchAll();
  mcpStore.fetchMcpData().catch(() => {});
  mcpStore.startPolling(15000);
});
onUnmounted(() => {
  unregisterTimeline?.();
  unregisterProcesses?.();
  mcpStore.stopPolling();
});
</script>

<style scoped>
.debug-layout { height:100%; display:flex; flex-direction:column; overflow:hidden; }
.debug-tabs { display:flex; gap:2px; padding:8px 12px; background:var(--surface-1); border-bottom:1px solid var(--border); flex-shrink:0; flex-wrap:wrap; }
.debug-tab-button { padding:5px 16px; font-size:12px; font-weight:500; color:var(--text-muted); background:none; border:none; border-radius:4px; cursor:pointer; font-family:inherit; transition:all .15s; }
.debug-tab-button:hover { color:var(--text); background:var(--surface-3); }

.debug-content { flex:1; overflow-y:auto; }
.debug-tab-content { padding:16px; }
.debug-loading,.debug-empty { padding:32px; text-align:center; color:var(--text-muted); font-size:13px; }
.debug-section { margin-bottom:24px; }
.debug-section-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
.debug-section-title { font-size:12px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; margin:0; }
.debug-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:6px; }
.debug-grid-item { display:flex; gap:8px; }
.dg-key { font-size:12px; color:var(--text-muted); }
.dg-value { font-size:12px; color:var(--text); }
.dg-value.mono, .mono { font-family:'SF Mono',monospace; font-size:11px; color:var(--accent-2); }
.operator-header { align-items:flex-start; gap:16px; }
.operator-subtitle { margin:6px 0 0; font-size:12px; color:var(--text-muted); }
.operator-actions-inline { display:flex; gap:8px; flex-wrap:wrap; }
.operator-freshness { margin-bottom:10px; font-size:12px; color:var(--text-muted); }
.operator-runtime-card { background:var(--surface-1); border:1px solid var(--surface-3); border-radius:8px; padding:16px; }
.operator-runtime-summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:8px; margin-bottom:12px; }
.sv-fetch-btn:disabled { opacity:.5; cursor:not-allowed; }
.operator-help-text { margin-top:10px; font-size:12px; color:var(--text-muted); }
.operator-note-card, .process-card { background:var(--surface-1); border:1px solid var(--surface-3); border-radius:8px; padding:12px; }
.process-card.selected { border-color:var(--accent-2); box-shadow:0 0 0 1px color-mix(in srgb, var(--accent-2) 45%, transparent); }
.operator-note-header { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px; }
.operator-note-kind { font-size:10px; font-weight:600; text-transform:uppercase; border-radius:999px; padding:2px 8px; background:var(--entry-user-bg); color:var(--accent-2); }
.operator-note-author { font-size:12px; color:var(--text); }
.operator-note-time { margin-left:auto; font-size:11px; color:var(--text-muted); }
.operator-note-body { font-size:13px; color:var(--text); white-space:pre-wrap; word-break:break-word; margin-bottom:8px; }
.operator-note-meta { display:flex; gap:12px; flex-wrap:wrap; font-size:11px; color:var(--text-muted); margin-bottom:10px; }
.errors-list { display:flex; flex-direction:column; gap:16px; }
.error-source-title { font-size:12px; font-weight:600; color:var(--text-muted); margin:0 0 6px 0; }
.error-item { padding:8px 12px; background:var(--surface-1); border:1px solid var(--surface-3); border-radius:6px; margin-bottom:6px; border-left:3px solid transparent; }
.error-item.sev-error { border-left-color:var(--danger); }
.error-item.sev-warning { border-left-color:var(--warn); }
.error-item.sev-info { border-left-color:var(--accent-2); }
.error-header { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
.error-severity-badge { font-size:10px; font-weight:600; padding:1px 5px; border-radius:3px; text-transform:uppercase; }
.error-severity-badge.sev-error { background:var(--entry-danger-bg); color:var(--danger); }
.error-severity-badge.sev-warning { background:var(--entry-warn-bg); color:var(--warn); }
.error-severity-badge.sev-info { background:var(--entry-user-bg); color:var(--accent-2); }
.error-type { font-size:11px; color:var(--text); font-family:'SF Mono',monospace; }
.error-time { font-size:10px; color:var(--border-strong); margin-left:auto; }
.error-message { font-size:13px; color:var(--text); }
.timeline-filter { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px; padding:10px; background:var(--surface-1); border:1px solid var(--surface-3); border-radius:6px; }
.timeline-filter-label { font-size:12px; color:var(--text-muted); font-weight:600; }
.timeline-filter-select { min-width:220px; max-width:340px; min-height:76px; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:4px; padding:6px; font-family:inherit; font-size:12px; }
.timeline-filter-help { font-size:11px; color:var(--text-muted); }
.timeline-list { display:flex; flex-direction:column; }
.tl-event { display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid var(--surface-3); font-size:12px; flex-wrap:wrap; }
.tl-event-type { font-family:'SF Mono',monospace; font-size:11px; color:var(--accent-2); font-weight:500; }
.tl-event-card { font-size:10px; color:var(--text-muted); }
.tl-event-time { font-size:10px; color:var(--border-strong); margin-left:auto; }
.agent-debug-layout { display:grid; grid-template-columns:minmax(220px,280px) 1fr; gap:16px; align-items:start; }
.agent-debug-sidebar { display:flex; flex-direction:column; gap:6px; max-height:70vh; overflow:auto; }
.agent-debug-session { display:flex; flex-direction:column; align-items:flex-start; gap:4px; padding:9px 10px; background:var(--surface-1); border:1px solid var(--surface-3); border-radius:6px; color:var(--text); cursor:pointer; font-family:inherit; text-align:left; }
.agent-debug-session:hover, .agent-debug-session.selected { border-color:var(--accent-2); background:var(--entry-user-bg); }
.agent-debug-session-id { color:var(--accent-2); }
.agent-debug-session-meta { font-size:11px; color:var(--text-muted); }
.agent-debug-toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
.agent-debug-toolbar .debug-tab-button:disabled { opacity:.45; cursor:not-allowed; }
.mcp-server-badge { font-size:10px; font-weight:600; padding:1px 5px; border-radius:4px; text-transform:uppercase; margin-left:8px; }
.mcp-server-badge.mcp-status-running { background:var(--entry-accent-bg); color:var(--accent); }
.mcp-server-badge.mcp-status-stopped { background:var(--surface-3); color:var(--text-muted); }
.mcp-server-badge.mcp-status-error { background:var(--entry-danger-bg); color:var(--danger); }
.mcp-server-transport { font-size:10px; color:var(--border-strong); margin-left:6px; font-family:'SF Mono',monospace; }
.mcp-tool-count { font-size:10px; color:var(--text-muted); margin-left:6px; }
.mcp-tool-card { padding:8px 12px; background:var(--surface-1); border:1px solid var(--surface-3); border-radius:6px; margin-bottom:6px; }
.mcp-server-title { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.mcp-server-name { text-transform:none; color:var(--text); }
.mcp-sep { color:var(--text-muted); font-weight:400; margin:0 6px; }
.mcp-tool-name-row { display:flex; align-items:baseline; flex-wrap:wrap; gap:8px; margin-bottom:4px; }
.mcp-tool-name { font-family:'SF Mono',monospace; font-size:12px; color:var(--accent-2); font-weight:600; }
.mcp-tool-desc { font-size:12px; color:var(--text-muted); }
.mcp-tool-stats { display:flex; flex-wrap:wrap; gap:12px; font-size:11px; color:var(--text-muted); }
.mcp-stat-item { display:inline-flex; align-items:center; gap:4px; }
.mcp-stat-success { color:var(--accent); }
.mcp-stat-error { color:var(--danger); }
.sv-stats-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:12px; }
.sv-stat-card { display:flex; flex-direction:column; align-items:flex-start; gap:4px; padding:12px; background:var(--surface-1); border:1px solid var(--surface-3); border-radius:6px; }
.sv-stat-num { font-size:22px; font-weight:700; color:var(--text); line-height:1; }
.sv-stat-label { font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
.sv-stat-card.sv-stat-blocked .sv-stat-num { color:var(--danger); }
.sv-stat-card.sv-stat-passed .sv-stat-num { color:var(--accent); }
.sv-stat-card.sv-stat-sanitized .sv-stat-num { color:var(--warn); }
.process-header { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
.process-status-badge { font-size:10px; font-weight:600; padding:2px 8px; border-radius:999px; text-transform:uppercase; }
.process-status-badge.ps-running { background:var(--entry-accent-bg); color:var(--accent); }
.process-status-badge.ps-exited { background:var(--entry-user-bg); color:var(--accent-2); }
.process-status-badge.ps-failed { background:var(--entry-danger-bg); color:var(--danger); }
.process-status-badge.ps-killed { background:var(--entry-warn-bg); color:var(--warn); }
.process-time { margin-left:auto; font-size:11px; color:var(--text-muted); }
.process-details, .process-logs { display:flex; flex-direction:column; gap:6px; margin-bottom:12px; }
.process-subtitle { font-size:11px; font-weight:600; color:var(--text-muted); text-transform:uppercase; }
.pd-row { display:flex; gap:8px; align-items:flex-start; }
.pd-key { min-width:120px; font-size:12px; color:var(--text-muted); }
.pd-value { font-size:12px; color:var(--text); }
.wrap { word-break:break-word; white-space:pre-wrap; }
.process-link-button, .sv-fetch-btn, .sv-q-browse-btn { margin-left:8px; padding:4px 8px; font-size:11px; color:var(--accent-2); background:var(--bg); border:1px solid var(--border); border-radius:4px; cursor:pointer; }
.process-empty-note { font-size:12px; color:var(--text-muted); line-height:1.5; }
</style>
