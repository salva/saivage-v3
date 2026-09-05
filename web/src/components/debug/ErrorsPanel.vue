<template>
  <div class="debug-tab-content">
    <ViewState v-if="errorsLoading" state="loading" title="Loading errors..." />
    <ViewState v-else-if="errorsError" state="error" title="Failed to load" :message="errorsError" />
    <ViewState
      v-else-if="errorsTotal === 0 && errors.length === 0"
      state="empty"
      title="No errors recorded."
    />
    <div v-else class="errors-list">
      <div v-for="entry in errorSourceEntries" :key="entry.source" class="error-source-group">
        <h4 class="error-source-title">{{ entry.source }} ({{ entry.errors.length }})</h4>
        <div
          v-for="err in entry.errors"
          :key="err.timestamp + err.message"
          class="error-item"
          :class="'sev-' + err.severity"
        >
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
</template>

<script setup lang="ts">
import type { ErrorSourceEntry } from '../../composables/useDebugReadModel';
import type { DebugErrorItem } from '../../stores/debug-read-model';
import { formatRecentTimestamp } from '../../utils/timestamp';
import CodeBlock from '../content/CodeBlock.vue';
import ViewState from '../ui/ViewState.vue';

defineProps<{
  errorsLoading: boolean;
  errorsError: string | null;
  errorsTotal: number;
  errors: readonly DebugErrorItem[];
  errorSourceEntries: readonly ErrorSourceEntry[];
}>();

function fmtDate(timestamp: string): string {
  return formatRecentTimestamp(timestamp);
}
</script>

<style scoped>
.errors-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.error-source-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  margin: 0 0 6px 0;
}
.error-item {
  padding: 8px 12px;
  background: var(--surface-1);
  border: 1px solid var(--surface-3);
  border-radius: 6px;
  margin-bottom: 6px;
  border-left: 3px solid transparent;
}
.error-item.sev-error { border-left-color: var(--danger); }
.error-item.sev-warning { border-left-color: var(--warn); }
.error-item.sev-info { border-left-color: var(--accent-2); }
.error-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.error-severity-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  text-transform: uppercase;
}
.error-severity-badge.sev-error { background: var(--entry-danger-bg); color: var(--danger); }
.error-severity-badge.sev-warning { background: var(--entry-warn-bg); color: var(--warn); }
.error-severity-badge.sev-info { background: var(--entry-user-bg); color: var(--accent-2); }
.error-type {
  font-size: 11px;
  color: var(--text);
  font-family: 'SF Mono', monospace;
}
.error-time {
  font-size: 10px;
  color: var(--border-strong);
  margin-left: auto;
}
.error-message {
  font-size: 13px;
  color: var(--text);
}
</style>
