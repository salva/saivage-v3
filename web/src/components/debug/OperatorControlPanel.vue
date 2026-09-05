<template>
  <div class="debug-tab-content">
    <section class="debug-section">
      <div class="debug-section-header operator-header">
        <div>
          <h4 class="debug-section-title">Runtime Diagnostics</h4>
          <p class="operator-subtitle">
            Inspect runtime state here. Ask the Analyst to Run, Pause, or Shutdown the runtime; use
            Debug &gt; Errors for durable command, precondition, activation, and actionable-error
            evidence.
          </p>
        </div>
        <div class="operator-actions-inline">
          <button class="sv-fetch-btn" :disabled="operatorPanelBusy" @click="emit('refresh')">Refresh</button>
        </div>
      </div>

      <div v-if="runtimeLastFetchedAt" class="operator-freshness" role="status">
        Last refreshed {{ absoluteDate(runtimeLastFetchedAt) }}
      </div>
      <div v-else class="operator-freshness" role="status">Not refreshed yet.</div>

      <ViewState v-if="!runtimeLoaded && runtimeLoading" state="loading" title="Loading runtime control state..." />
      <ViewState
        v-else-if="!runtimeLoaded && runtimeError"
        state="error"
        title="Failed to load runtime state"
        :message="runtimeError"
      />
      <div v-else class="operator-runtime-card">
        <div class="operator-runtime-summary">
          <div class="debug-grid-item">
            <span class="dg-key">Status:</span><StatusBadge :status="statusForRuntimeStatus(runtimeStatusLabel)" />
          </div>
          <div class="debug-grid-item">
            <span class="dg-key">Current Card:</span><span class="dg-value mono">{{ currentCardId || 'none' }}</span>
          </div>
        </div>
        <StatusBanner v-if="runtimeRefreshError" tone="warning" :message="runtimeRefreshError" />
        <ViewState v-if="runtimeLoaded && !runtime" state="empty" title="No live runtime." />
        <div class="operator-runtime-guidance" role="note">
          Debug is diagnostic-only. Lifecycle changes are Analyst-owned. Dashboard shows current
          runtime and activation ownership; Debug &gt; Errors is the durable error surface.
        </div>
      </div>
    </section>

    <section class="debug-section">
      <div class="debug-section-header operator-header">
        <div>
          <h4 class="debug-section-title">Actionable runtime issues</h4>
          <p class="operator-subtitle">
            Durable command, runtime precondition, activation, and actionable-error evidence is
            reported in Debug &gt; Errors with next-action guidance where available.
          </p>
        </div>
      </div>
      <ViewState state="empty" title="Open Debug > Errors for durable runtime issues." />
    </section>
  </div>
</template>

<script setup lang="ts">
import type { RuntimeState } from '../../api/types';
import { statusForRuntimeStatus } from '../../utils/status';
import { formatTimestamp } from '../../utils/timestamp';
import StatusBadge from '../ui/StatusBadge.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';

defineProps<{
  runtime: RuntimeState | null;
  runtimeLoaded: boolean;
  runtimeLoading: boolean;
  runtimeError: string | null;
  runtimeRefreshError: string | null;
  runtimeLastFetchedAt: string | null;
  runtimeStatusLabel: string;
  currentCardId: string | null;
  operatorPanelBusy: boolean;
}>();

const emit = defineEmits<{ refresh: [] }>();

function absoluteDate(timestamp: string): string {
  return formatTimestamp(timestamp, 'absolute');
}
</script>

<style scoped>
.dg-value.mono,
.mono {
  font-family: 'SF Mono', monospace;
  font-size: 11px;
  color: var(--accent-2);
}
.operator-freshness {
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--text-muted);
}
.operator-runtime-card {
  background: var(--surface-1);
  border: 1px solid var(--surface-3);
  border-radius: 8px;
  padding: 16px;
}
.operator-runtime-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
</style>
