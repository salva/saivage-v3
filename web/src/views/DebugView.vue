<template>
  <div class="debug-layout">
    <div class="debug-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="debug-tab"
        :class="{ active: localActiveTab === tab.id }"
        @click="setTab(tab.id)"
      >{{ tab.label }}</button>
    </div>

    <div class="debug-content">
      <!-- State Tab -->
      <div v-if="localActiveTab === 'state'" class="debug-tab-content">
        <div v-if="loading" class="debug-loading">Loading state...</div>
        <div v-else-if="error" class="debug-error">{{ error }}</div>
        <template v-else>
          <section class="debug-section">
            <h4 class="debug-section-title">Runtime State</h4>
            <div v-if="debugRuntime" class="debug-grid">
              <div class="dg-item"><span class="dg-key">Status:</span><span class="dg-value">{{ debugRuntime.status }}</span></div>
              <div class="dg-item"><span class="dg-key">PID:</span><span class="dg-value">{{ debugRuntime.pid }}</span></div>
              <div class="dg-item"><span class="dg-key">Started:</span><span class="dg-value">{{ fmtDate(debugRuntime.started_at) }}</span></div>
              <div class="dg-item"><span class="dg-key">Paused:</span><span class="dg-value">{{ debugRuntime.paused ? 'Yes' : 'No' }}</span></div>
              <div class="dg-item"><span class="dg-key">Current Card:</span><span class="dg-value mono">{{ debugRuntime.current_card_id || 'none' }}</span></div>
              <div class="dg-item"><span class="dg-key">Agent Session:</span><span class="dg-value mono">{{ debugRuntime.current_agent_session_id || 'none' }}</span></div>
              <div class="dg-item"><span class="dg-key">Running Procs:</span><span class="dg-value">{{ debugRuntime.running_processes?.length || 0 }}</span></div>
              <div class="dg-item"><span class="dg-key">Queue:</span><span class="dg-value">{{ debugRuntime.queue?.length || 0 }} cards</span></div>
            </div>
            <div v-else class="debug-empty">No runtime state.</div>
          </section>

          <section class="debug-section">
            <h4 class="debug-section-title">Cards ({{ debugTotalCards }} total)</h4>
            <div class="card-summary-bars">
              <div v-for="entry in cardStatusEntries" :key="entry.status" class="csb-row">
                <span class="csb-label">{{ entry.status }}</span>
                <div class="csb-track"><div class="csb-fill" :class="'s-' + entry.status" :style="{ width: (entry.count / maxStatusCount) * 100 + '%' }"></div></div>
                <span class="csb-count">{{ entry.count }}</span>
              </div>
            </div>
            <div class="debug-card-list">
              <div v-for="card in debugCards" :key="card.id" class="dc-item" :class="'dc-' + card.status">
                <span class="dc-type">{{ card.type[0].toUpperCase() }}</span>
                <span class="dc-title">{{ card.title }}</span>
                <span class="dc-status" :class="'s-' + card.status">{{ card.status }}</span>
                <span class="dc-priority">P{{ card.priority }}</span>
                <span v-if="card.depends_on.length" class="dc-deps">{{ card.depends_on.length }}</span>
              </div>
            </div>
            <div v-if="debugCards.length === 0" class="debug-empty">No cards.</div>
          </section>
        </template>
      </div>

      <!-- Errors Tab -->
      <div v-if="localActiveTab === 'errors'" class="debug-tab-content">
        <div v-if="loading" class="debug-loading">Loading errors...</div>
        <div v-else-if="errorsTotal === 0 && errors.length === 0" class="debug-empty">No errors recorded.</div>
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
              <pre v-if="err.details" class="error-details">{{ err.details }}</pre>
            </div>
          </div>
        </div>
      </div>

      <!-- Timeline Tab -->
      <div v-if="localActiveTab === 'timeline'" class="debug-tab-content">
        <div v-if="loading" class="debug-loading">Loading timeline...</div>
        <div v-else-if="sortedTimeline.length === 0" class="debug-empty">No timeline events.</div>
        <div v-else class="timeline-list">
          <div v-for="event in sortedTimeline" :key="event.timestamp + event.type + (event.card_id || '')" class="tl-event">
            <span class="tl-event-type">{{ event.type }}</span>
            <span v-if="event.card_id" class="tl-event-card mono">{{ event.card_id.slice(0,12) }}</span>
            <span class="tl-event-time">{{ fmtDate(event.timestamp) }}</span>
            <pre v-if="event.data && Object.keys(event.data).length" class="tl-event-data">{{ fmtJson(event.data) }}</pre>
          </div>
        </div>
      </div>

      <!-- MCP Tab -->
      <div v-if="localActiveTab === 'mcp'" class="debug-tab-content">
        <div v-if="mcpStore.loading" class="debug-loading">Loading MCP tools...</div>
        <div v-else-if="mcpStore.error" class="debug-error">{{ mcpStore.error }}</div>
        <div v-else-if="mcpStore.serverCount === 0" class="debug-empty">No MCP servers configured or running.</div>
        <div v-else class="mcp-content">
          <!-- Summary Row -->
          <section class="debug-section">
            <h4 class="debug-section-title">Summary</h4>
            <div class="debug-grid">
              <div class="dg-item"><span class="dg-key">Servers:</span><span class="dg-value">{{ mcpStore.serverCount }}</span></div>
              <div class="dg-item"><span class="dg-key">Tools:</span><span class="dg-value">{{ mcpStore.toolCount }}</span></div>
              <div class="dg-item"><span class="dg-key">Invocations:</span><span class="dg-value">{{ mcpStore.totalInvocations }} ({{ mcpStore.totalErrors }} errors)</span></div>
              <div v-if="mcpStore.lastRefreshed" class="dg-item"><span class="dg-key">Last Refreshed:</span><span class="dg-value">{{ fmtDate(mcpStore.lastRefreshed) }}</span></div>
            </div>
          </section>

          <!-- Per-Server Sections -->
          <section v-for="server in mcpStore.servers" :key="server.name" class="debug-section">
            <h4 class="debug-section-title">
              {{ server.name }}
              <span class="mcp-server-badge" :class="'mcp-status-' + server.status">{{ server.status }}</span>
              <span class="mcp-server-transport">{{ server.transport }}</span>
              <span class="mcp-tool-count">{{ server.toolCount }} tools</span>
            </h4>

            <div v-if="server.tools.length === 0" class="debug-empty" style="padding:8px;font-size:12px;">No tools discovered.</div>

            <div v-for="tool in server.tools" :key="tool.name" class="mcp-tool-card">
              <div class="mcp-tool-name-row">
                <span class="mcp-tool-name">{{ tool.name }}</span>
                <span class="mcp-tool-desc">{{ tool.description || 'No description' }}</span>
              </div>
              <div class="mcp-tool-stats">
                <span class="mcp-stat-item" title="Total invocations">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1"/><line x1="6" y1="3" x2="6" y2="7" stroke="currentColor" stroke-width="1"/><line x1="4" y1="9" x2="8" y2="9" stroke="currentColor" stroke-width="1"/></svg>
                  {{ tool.stats.total }}
                </span>
                <span class="mcp-stat-item mcp-stat-success" title="Successful invocations">✓ {{ tool.stats.success }}</span>
                <span class="mcp-stat-item mcp-stat-error" title="Failed invocations">✗ {{ tool.stats.error }}</span>
                <span v-if="tool.stats.lastInvokedAt" class="mcp-stat-item mcp-stat-time" title="Last invoked">{{ fmtDate(tool.stats.lastInvokedAt) }}</span>
              </div>
            </div>
          </section>

          <!-- Invocation Stats Table -->
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useDebugStore } from '../stores/debug';
import { useMcpStore } from '../stores/mcp';
import type { DebugError } from '../api/types';
import { createLogger } from '../utils/logger';

const log = createLogger('view:debug');
const debugStore = useDebugStore();
const mcpStore = useMcpStore();
const {
  debugRuntime, debugCards, debugTotalCards,
  errors, errorsTotal, errorsBySource,
  sortedTimeline, loading, error,
} = storeToRefs(debugStore);

type TabId = 'state' | 'errors' | 'timeline' | 'mcp';

const tabs = [
  { id: 'state' as const, label: 'State' },
  { id: 'errors' as const, label: 'Errors' },
  { id: 'timeline' as const, label: 'Timeline' },
  { id: 'mcp' as const, label: 'MCP' },
];

const localActiveTab = ref<TabId>('state');

function setTab(tab: TabId): void {
  localActiveTab.value = tab;
  if (tab === 'state') debugStore.fetchState().catch(() => {});
  else if (tab === 'errors') debugStore.fetchErrors().catch(() => {});
  else if (tab === 'timeline') debugStore.fetchTimeline().catch(() => {});
  else if (tab === 'mcp') mcpStore.fetchMcpData().catch(() => {});
}

interface CardStatusEntry { status: string; count: number }
const cardStatusEntries = computed<CardStatusEntry[]>(() => {
  const counts: Record<string, number> = {};
  for (const card of debugCards.value) {
    counts[card.status] = (counts[card.status] || 0) + 1;
  }
  return Object.entries(counts).map(([status, count]) => ({ status, count }));
});

const maxStatusCount = computed(() => Math.max(...cardStatusEntries.value.map(e => e.count), 1));

interface ErrorSourceEntry { source: string; errors: DebugError[] }
const errorSourceEntries = computed<ErrorSourceEntry[]>(() => {
  const entries: ErrorSourceEntry[] = [];
  for (const [source, errs] of errorsBySource.value) {
    entries.push({ source, errors: errs });
  }
  return entries;
});

function fmtDate(ts: string): string { try { return new Date(ts).toLocaleString(); } catch { return ts; } }
function fmtJson(data: Record<string, unknown>): string {
  try { return JSON.stringify(data, null, 2); } catch { return String(data); }
}

onMounted(async () => {
  debugStore.setupWsListener();
  await debugStore.fetchAll();

  mcpStore.fetchMcpData().catch(() => {});
  mcpStore.startPolling(15000);
});

onUnmounted(() => {
  mcpStore.stopPolling();
});
</script>

<style scoped>
.debug-layout { height:100%; display:flex; flex-direction:column; overflow:hidden; }
.debug-tabs { display:flex; gap:2px; padding:8px 12px; background:#161b22; border-bottom:1px solid #30363d; flex-shrink:0; }
.debug-tab { padding:5px 16px; font-size:12px; font-weight:500; color:#8b949e; background:none; border:none; border-radius:4px; cursor:pointer; font-family:inherit; transition:all .15s; }
.debug-tab:hover { color:#c9d1d9; background:#21262d; }
.debug-tab.active { background:#30363d; color:#f0f6fc; }
.debug-content { flex:1; overflow-y:auto; }
.debug-tab-content { padding:16px; }
.debug-loading,.debug-empty,.debug-error { padding:32px; text-align:center; color:#8b949e; font-size:13px; }
.debug-error { color:#f85149; }
.debug-section { margin-bottom:24px; }
.debug-section-title { font-size:12px; font-weight:600; color:#8b949e; text-transform:uppercase; letter-spacing:.03em; margin:0 0 10px 0; }
.debug-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:6px; }
.dg-item { display:flex; gap:8px; }
.dg-key { font-size:12px; color:#8b949e; }
.dg-value { font-size:12px; color:#c9d1d9; }
.dg-value.mono { font-family:'SF Mono',monospace; font-size:11px; color:#58a6ff; }
.mono { font-family:'SF Mono',monospace; }
.card-summary-bars { display:flex; flex-direction:column; gap:4px; margin-bottom:12px; }
.csb-row { display:grid; grid-template-columns:80px 1fr 40px; gap:8px; align-items:center; }
.csb-label { font-size:11px; color:#8b949e; text-transform:capitalize; text-align:right; }
.csb-track { height:6px; background:#21262d; border-radius:3px; overflow:hidden; }
.csb-fill { height:100%; border-radius:3px; }
.csb-fill.s-drafting { background:#484f58; }
.csb-fill.s-backlog { background:#8b949e; }
.csb-fill.s-active { background:#58a6ff; }
.csb-fill.s-running { background:#3fb950; }
.csb-fill.s-blocked { background:#d29922; }
.csb-fill.s-done { background:#7ee787; }
.csb-fill.s-failed { background:#f85149; }
.csb-fill.s-cancelled { background:#484f58; }
.csb-count { font-size:11px; color:#c9d1d9; font-family:'SF Mono',monospace; }
.debug-card-list { display:flex; flex-direction:column; gap:2px; }
.dc-item { display:flex; align-items:center; gap:8px; padding:4px 8px; border-radius:4px; font-size:12px; }
.dc-item:hover { background:#161b22; }
.dc-type { width:18px; text-align:center; font-family:'SF Mono',monospace; font-size:10px; font-weight:600; color:#8b949e; }
.dc-title { flex:1; color:#c9d1d9; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dc-status { font-size:10px; font-weight:600; padding:1px 5px; border-radius:4px; text-transform:uppercase; }
.dc-status.s-drafting { color:#8b949e; background:#21262d; }
.dc-status.s-backlog { color:#c9d1d9; background:#21262d; }
.dc-status.s-active,.dc-status.s-running { color:#58a6ff; background:#1c2738; }
.dc-status.s-blocked { color:#d29922; background:#241f18; }
.dc-status.s-done { color:#7ee787; background:#1a2418; }
.dc-status.s-failed { color:#f85149; background:#241818; }
.dc-status.s-cancelled { color:#484f58; background:#21262d; }
.dc-priority { font-size:10px; color:#8b949e; font-family:'SF Mono',monospace; }
.dc-deps { font-size:10px; color:#484f58; }
.errors-list { display:flex; flex-direction:column; gap:16px; }
.error-source-title { font-size:12px; font-weight:600; color:#8b949e; margin:0 0 6px 0; }
.error-item { padding:8px 12px; background:#161b22; border:1px solid #21262d; border-radius:6px; margin-bottom:6px; border-left:3px solid transparent; }
.error-item.sev-error { border-left-color:#f85149; }
.error-item.sev-warning { border-left-color:#d29922; }
.error-item.sev-info { border-left-color:#58a6ff; }
.error-header { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
.error-severity-badge { font-size:10px; font-weight:600; padding:1px 5px; border-radius:3px; text-transform:uppercase; }
.error-severity-badge.sev-error { background:#241818; color:#f85149; }
.error-severity-badge.sev-warning { background:#241f18; color:#d29922; }
.error-severity-badge.sev-info { background:#1c2738; color:#58a6ff; }
.error-type { font-size:11px; color:#c9d1d9; font-family:'SF Mono',monospace; }
.error-time { font-size:10px; color:#484f58; margin-left:auto; }
.error-message { font-size:13px; color:#c9d1d9; }
.error-details { margin:6px 0 0; padding:8px; background:#0d1117; border:1px solid #21262d; border-radius:4px; font-size:11px; font-family:'SF Mono',monospace; line-height:1.5; white-space:pre-wrap; word-break:break-word; color:#8b949e; }
.timeline-list { display:flex; flex-direction:column; }
.tl-event { display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid #21262d; font-size:12px; flex-wrap:wrap; }
.tl-event-type { font-family:'SF Mono',monospace; font-size:11px; color:#58a6ff; font-weight:500; }
.tl-event-card { font-size:10px; color:#8b949e; }
.tl-event-time { font-size:10px; color:#484f58; margin-left:auto; }
.tl-event-data { width:100%; margin-top:4px; padding:6px; background:#0d1117; border:1px solid #21262d; border-radius:4px; font-size:10px; font-family:'SF Mono',monospace; line-height:1.4; white-space:pre-wrap; word-break:break-word; color:#8b949e; max-height:100px; overflow-y:auto; }

/* ── MCP Styles ── */
.mcp-server-badge { font-size:10px; font-weight:600; padding:1px 5px; border-radius:4px; text-transform:uppercase; margin-left:8px; }
.mcp-server-badge.mcp-status-running { background:#1a2418; color:#7ee787; }
.mcp-server-badge.mcp-status-stopped { background:#21262d; color:#8b949e; }
.mcp-server-badge.mcp-status-error { background:#241818; color:#f85149; }
.mcp-server-transport { font-size:10px; color:#484f58; margin-left:6px; font-family:'SF Mono',monospace; }
.mcp-tool-count { font-size:10px; color:#8b949e; margin-left:6px; }
.mcp-tool-card { padding:8px 12px; background:#161b22; border:1px solid #21262d; border-radius:6px; margin-bottom:6px; }
.mcp-tool-name-row { display:flex; align-items:baseline; gap:8px; margin-bottom:4px; }
.mcp-tool-name { font-family:'SF Mono',monospace; font-size:13px; color:#58a6ff; font-weight:500; }
.mcp-tool-desc { font-size:11px; color:#8b949e; }
.mcp-tool-stats { display:flex; gap:12px; align-items:center; }
.mcp-stat-item { font-size:11px; color:#8b949e; display:flex; align-items:center; gap:3px; }
.mcp-stat-item.mcp-stat-success { color:#7ee787; }
.mcp-stat-item.mcp-stat-error { color:#f85149; }
.mcp-stat-item.mcp-stat-time { font-size:10px; color:#484f58; }
.mcp-stats-table { display:flex; flex-direction:column; font-size:11px; }
.mcp-stats-header,.mcp-stats-row { display:grid; grid-template-columns:2fr 60px 60px 60px 120px; gap:8px; padding:4px 8px; }
.mcp-stats-header { color:#8b949e; font-weight:600; border-bottom:1px solid #21262d; }
.mcp-stats-row { border-bottom:1px solid #161b22; }
.mcp-stats-row:hover { background:#161b22; }
.mcp-stats-cell { color:#c9d1d9; }
.mcp-stats-cell.mono { font-family:'SF Mono',monospace; font-size:10px; color:#58a6ff; }
.mcp-stats-cell.mcp-stat-success { color:#7ee787; }
.mcp-stats-cell.mcp-stat-error { color:#f85149; }
.mcp-stats-cell.mcp-stat-time { color:#484f58; }
.mcp-content { padding:0; }
</style>
