<template>
  <div class="debug-tab-content">
    <section class="debug-section" data-testid="debug-runtime-state">
      <h4 class="debug-section-title">Runtime State</h4>
      <ViewState v-if="!runtimeLoaded && runtimeLoading" state="loading" title="Loading runtime state..." />
      <ViewState
        v-else-if="!runtimeLoaded && runtimeError"
        state="error"
        title="Failed to load runtime state"
        :message="runtimeError"
      />
      <StatusBanner v-if="runtimeRefreshing" tone="stale" message="Refreshing runtime state…" />
      <StatusBanner v-else-if="runtimeRefreshError" tone="warning" :message="runtimeRefreshError" />
      <div v-if="runtime" class="debug-grid">
        <div class="debug-grid-item">
          <span class="dg-key">Status:</span><span class="dg-value">{{ runtime.status }}</span>
        </div>
        <div class="debug-grid-item">
          <span class="dg-key">PID:</span><span class="dg-value">{{ runtime.pid }}</span>
        </div>
        <div class="debug-grid-item">
          <span class="dg-key">Started:</span><span class="dg-value">{{ fmtDate(runtime.started_at) }}</span>
        </div>
        <div class="debug-grid-item">
          <span class="dg-key">Current Card:</span><span class="dg-value mono">{{ currentCardId || 'none' }}</span>
        </div>
      </div>
      <ViewState v-else-if="runtimeLoaded" state="empty" title="No live runtime." />
      <ViewState v-else state="empty" title="Runtime state not loaded." />
      <section v-if="oversight" class="debug-section" data-testid="debug-oversight-state">
        <h4 class="debug-section-title">Project Oversight</h4>
        <div class="debug-grid">
          <div class="debug-grid-item"><span class="dg-key">State:</span><span class="dg-value">{{ oversight.state }}</span></div>
          <div class="debug-grid-item"><span class="dg-key">Agent:</span><span class="dg-value mono">{{ oversight.agent_name }}</span></div>
          <div class="debug-grid-item"><span class="dg-key">Session:</span><span class="dg-value mono">{{ oversight.session_id }}</span></div>
          <div class="debug-grid-item"><span class="dg-key">Enabled:</span><span class="dg-value">{{ oversight.enabled ? 'yes' : 'no' }}</span></div>
          <div class="debug-grid-item"><span class="dg-key">Eligibility:</span><span class="dg-value">{{ oversight.eligible ? 'eligible' : oversight.eligibility_reason }}</span></div>
          <div class="debug-grid-item"><span class="dg-key">Service epoch:</span><span class="dg-value">{{ fmtDate(oversight.service_epoch) }}</span></div>
          <div class="debug-grid-item"><span class="dg-key">Next due:</span><span class="dg-value">{{ oversight.next_nominal_due ? fmtDate(oversight.next_nominal_due) : 'none' }}</span></div>
          <div class="debug-grid-item"><span class="dg-key">Last attempt:</span><span class="dg-value">{{ oversight.last_attempt ? `${oversight.last_attempt.outcome} · ${fmtDate(oversight.last_attempt.settled_at)}` : 'none' }}</span></div>
          <div class="debug-grid-item"><span class="dg-key">Last success:</span><span class="dg-value">{{ oversight.last_successful_at ? fmtDate(oversight.last_successful_at) : 'none' }}</span></div>
        </div>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { RuntimeState } from '../../api/types';
import type { OperatorApiSuccess } from '../../api/contracts';
import { formatRecentTimestamp } from '../../utils/timestamp';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';

defineProps<{
  runtime: RuntimeState | null;
  runtimeLoaded: boolean;
  runtimeLoading: boolean;
  runtimeError: string | null;
  runtimeRefreshing: boolean;
  runtimeRefreshError: string | null;
  currentCardId: string | null;
  oversight:OperatorApiSuccess<'runtime.status'>['oversight']|null;
}>();

function fmtDate(timestamp: string): string {
  return formatRecentTimestamp(timestamp);
}
</script>

<style scoped>
.dg-value.mono,
.mono {
  font-family: 'SF Mono', monospace;
  font-size: 11px;
  color: var(--accent-2);
}
</style>
