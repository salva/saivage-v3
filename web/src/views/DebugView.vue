<template>
  <div class="debug-layout">
    <div class="debug-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="debug-tab"
        :class="{ active: activeTab === tab.id }"
        @click="setTab(tab.id)"
      >{{ tab.label }}</button>
    </div>

    <div class="debug-content">
      <!-- State Tab -->
      <div v-if="activeTab === 'state'" class="debug-tab-content">
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
      <div v-if="activeTab === 'errors'" class="debug-tab-content">
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
      <div v-if="activeTab === 'timeline'" class="debug-tab-content">
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useDebugStore } from '../stores/debug';
import type { DebugError } from '../api/types';
import { createLogger } from '../utils/logger';

const log = createLogger('view:debug');
const debugStore = useDebugStore();
const {
  debugRuntime, debugCards, debugTotalCards,
  errors, errorsTotal, errorsBySource,
  sortedTimeline, loading, error, activeTab,
} = storeToRefs(debugStore);

const tabs = [
  { id: 'state' as const, label: 'State' },
  { id: 'errors' as const, label: 'Errors' },
  { id: 'timeline' as const, label: 'Timeline' },
];

function setTab(tab: 'state' | 'errors' | 'timeline'): void {
  debugStore.setActiveTab(tab);
  if (tab === 'state') debugStore.fetchState().catch(() => {});
  else if (tab === 'errors') debugStore.fetchErrors().catch(() => {});
  else if (tab === 'timeline') debugStore.fetchTimeline().catch(() => {});
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
</style>
