<template>
  <div class="debug-tab-content">
    <div class="debug-section-header operator-header">
      <div>
        <h4 class="debug-section-title">Processes</h4>
        <p class="operator-subtitle">
          Inspect Saivage-managed process records using redacted commands and contained log references.
        </p>
      </div>
      <div class="operator-actions-inline">
        <button class="sv-fetch-btn" :disabled="processesLoading" @click="emit('refresh')">Refresh</button>
      </div>
    </div>

    <ViewState v-if="processesLoading" state="loading" title="Loading processes..." />
    <ViewState v-else-if="processesError" state="error" title="Failed to load" :message="processesError" />
    <ViewState
      v-else-if="sortedProcesses.length === 0"
      state="empty"
      title="No Saivage-managed processes found."
    />
    <div v-else class="processes-list">
      <div
        v-for="proc in sortedProcesses"
        :key="proc.id"
        class="process-card"
        :class="{ selected: selectedProcessId === proc.id }"
      >
        <div class="process-header">
          <span class="process-status-badge" :class="'ps-' + proc.status">{{ processLabel(proc) }}</span>
          <span v-if="proc.started_at" class="pd-lead-time">started {{ fmtDate(proc.started_at) }}<template v-if="proc.ended_at"> · ended {{ fmtDate(proc.ended_at) }}</template></span>
          <span class="process-id mono" :title="proc.id">{{ proc.id }}</span>
          <span class="process-time">Started {{ fmtDate(proc.started_at) }}</span>
        </div>
        <div class="process-details">
          <div class="pd-row"><span class="pd-key">Command:</span><span class="pd-value mono wrap">{{ proc.command }}</span></div>
          <div class="pd-row"><span class="pd-key">Card:</span><span class="pd-value"><router-link v-if="proc.card_id" :to="{ name: 'card-detail', params: { id: proc.card_id } }">{{ proc.card_id }}</router-link><span v-else>none</span></span></div>
          <div class="pd-row"><span class="pd-key">Session:</span><span class="pd-value mono">{{ proc.session_id || 'none' }}</span></div>
          <div class="pd-row"><span class="pd-key">Owner kind:</span><span class="pd-value mono">{{ proc.owner_kind || 'unknown' }}</span></div>
          <div class="pd-row"><span class="pd-key">Owner id:</span><span class="pd-value mono">{{ proc.owner_id || 'unknown' }}</span></div>
          <div class="pd-row">
            <span class="pd-key">Working directory:</span>
            <span class="pd-value mono wrap">{{ proc.cwd || 'Unavailable or unsafe to display' }}</span>
          </div>
          <div v-if="proc.ended_at" class="pd-row"><span class="pd-key">Ended:</span><span class="pd-value">{{ fmtDate(proc.ended_at) }}</span></div>
          <div class="pd-row"><span class="pd-key">Exit code:</span><span class="pd-value mono">{{ proc.exit_code ?? '-' }}</span></div>
          <div v-if="proc.timed_out" class="pd-row"><span class="pd-key">Timed out:</span><span class="pd-value">Yes</span></div>
        </div>

        <div class="process-details">
          <div class="pd-row">
            <span class="pd-key">Group:</span
            ><span class="pd-value wrap"
              >{{
                proc.evidence.group === 'tracked'
                  ? 'Tracked — absence not confirmed'
                  : proc.evidence.group === 'unverifiable'
                    ? 'Unverifiable — containment unconfirmed'
                    : 'Absence confirmed'
              }}<template v-if="proc.evidence.group_diagnostic">
                · {{ proc.evidence.group_diagnostic }}</template
              ></span
            >
          </div>
          <div class="pd-row">
            <span class="pd-key">Leader exit observed:</span
            ><span class="pd-value wrap"
              ><template v-if="proc.evidence.leader_exit"
                >code {{ proc.evidence.leader_exit.exit_code ?? 'null' }} · signal
                {{ proc.evidence.leader_exit.signal ?? 'null' }} ·
                {{ fmtDate(proc.evidence.leader_exit.observed_at) }}</template
              ><template v-else>Not observed</template></span
            >
          </div>
          <div v-if="proc.evidence.leader_error" class="pd-row">
            <span class="pd-key">Leader error:</span
            ><span class="pd-value wrap"
              >{{ proc.evidence.leader_error.diagnostic }} ·
              {{ fmtDate(proc.evidence.leader_error.observed_at) }}</span
            >
          </div>
          <div v-for="stream in ['stdout', 'stderr'] as const" :key="stream" class="pd-row">
            <span class="pd-key">{{ stream }} evidence:</span
            ><span class="pd-value wrap"
              >{{ streamLabel(proc.evidence[stream])
              }}<template v-if="proc.evidence[`${stream}_error`]">
                · Capture failed: {{ proc.evidence[`${stream}_error`] }}</template
              ></span
            >
          </div>
          <p v-if="proc.status === 'unavailable'" class="process-empty-note">
            Later activations cannot take ownership. Service-level intervention requires the
            operator; this observation does not confirm cleanup or process completion.
          </p>
        </div>

        <div class="process-logs">
          <div class="process-subtitle">Logs</div>
          <div v-if="!hasProcessLogs(proc)" class="process-empty-note">
            No safe log references are available for this process.
          </div>
          <div v-else>
            <div v-for="logEntry in processLogEntries(proc)" :key="logEntry.key" class="pd-row">
              <span class="pd-key">{{ logEntry.label }}:</span>
              <span v-if="logEntry.value" class="pd-value mono wrap">
                {{ logEntry.value }}
                <button class="process-link-button" @click="emit('browse-log', logEntry.value)">Browse</button>
              </span>
              <span v-else class="pd-value">Not available</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ProcessView } from '../../api/types';
import { formatRecentTimestamp } from '../../utils/timestamp';
import ViewState from '../ui/ViewState.vue';

defineProps<{
  processesLoading: boolean;
  processesError: string | null;
  sortedProcesses: readonly ProcessView[];
  selectedProcessId: string | null;
}>();

const emit = defineEmits<{
  refresh: [];
  'browse-log': [path: string];
}>();

function processLogEntries(proc: ProcessView): Array<{ key: string; label: string; value: string | null }> {
  return [
    { key: 'stdout', label: 'Stdout', value: proc.logs.stdout },
    { key: 'stderr', label: 'Stderr', value: proc.logs.stderr },
  ];
}

function hasProcessLogs(proc: ProcessView): boolean {
  return processLogEntries(proc).some((entry) => Boolean(entry.value));
}

function fmtDate(timestamp: string): string {
  return formatRecentTimestamp(timestamp);
}


function processLabel(proc: ProcessView): string {
  if (proc.status === 'unavailable') return 'Evidence unavailable';
  if (proc.status === 'running' && proc.evidence.leader_exit)
    return 'Awaiting group/output settlement';
  return proc.status;
}

function streamLabel(state: ProcessView['evidence']['stdout']): string {
  return {
    open: 'Stream open',
    eof: 'EOF observed',
    closed: 'Closed without observed EOF',
    not_captured: 'Not captured by runner',
  }[state];
}
</script>

<style scoped>
.pd-lead-time { font-size: 11px; color: var(--text-muted); }
.mono {
  font-family: 'SF Mono', monospace;
  font-size: 11px;
  color: var(--accent-2);
}
.process-card {
  background: var(--surface-1);
  border: 1px solid var(--surface-3);
  border-radius: 8px;
  padding: 12px;
}
.process-card.selected {
  border-color: var(--accent-2);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-2) 45%, transparent);
}
.process-header {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.process-status-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  text-transform: uppercase;
}
.process-status-badge.ps-running { background: var(--entry-accent-bg); color: var(--accent); }
.process-status-badge.ps-exited { background: var(--entry-user-bg); color: var(--accent-2); }
.process-status-badge.ps-failed { background: var(--entry-danger-bg); color: var(--danger); }
.process-status-badge.ps-unavailable {
  background: var(--entry-danger-bg);
  color: var(--danger);
}
.process-status-badge.ps-killed { background: var(--entry-warn-bg); color: var(--warn); }
.process-time { margin-left: auto; font-size: 11px; color: var(--text-muted); }
.process-details,
.process-logs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.process-subtitle { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; }
.pd-row { display: flex; gap: 8px; align-items: flex-start; }
.pd-key { min-width: 120px; font-size: 12px; color: var(--text-muted); }
.pd-value { font-size: 12px; color: var(--text); }
.wrap { word-break: break-word; white-space: pre-wrap; }
.process-link-button {
  margin-left: 8px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--accent-2);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
}
.process-empty-note { font-size: 12px; color: var(--text-muted); line-height: 1.5; }
</style>
