<template>
  <header class="workspace-header">
    <div class="header-left">
      <h1 class="section-title">{{ sectionTitle }}</h1>
    </div>

    <div class="header-right">
      <span
        class="pill header-chip"
        :class="`ws-${connectionState}`"
        :title="socketDetail"
      >
        <span class="status-dot"></span>
        {{ wsDisplayLabel }}
      </span>

      <span
        class="pill header-chip"
        :class="runtimeChipClass"
        :title="runtimeChipTitle"
      >
        <span class="status-dot"></span>
        {{ runtimeModeLabel || runtimeStatusLabel }}
      </span>

    <span v-if="stateCueLabel" class="pill header-chip cue-chip" :class="cueClass" :title="stateCueDetail">
        <span class="status-dot"></span>
        {{ stateCueLabel }}
      </span>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, unref } from 'vue';
import type { WsConnectionState } from '../../api/types';
import { selectSocketDetail } from '../../stores/runtime-read-model';

const props = defineProps<{
  sectionTitle: string;
  connectionState: WsConnectionState;
  runtimeStatus: string | null;
  runtimeStatusLabel: string;
  runtimeModeLabel?: string;
  runtimeModeDetail?: string;
  isUnauthorized?: boolean;
}>();

const wsLabel = computed(() => {
  const labels: Record<string, string> = {
    connected: 'Live',
    connecting: 'Connecting',
    offline: 'Offline',
    unauthorized: 'Unauthorized',
  };
  return labels[props.connectionState];
});

const wsDisplayLabel = wsLabel;
const socketDetail = computed(() => selectSocketDetail(props.connectionState));

const runtimeChipClass = computed(() => `rt-${props.runtimeStatus || 'unknown'}`);
const runtimeChipTitle = computed(() => {
  const detail = String(unref(props.runtimeModeDetail) || 'Runtime status is observable here. Ask the Analyst to Run, Pause, or Shutdown the runtime.');
  if (detail.includes('Analyst')) return detail;
  return `${detail} Ask the Analyst to Run, Pause, or Shutdown the runtime.`;
});
const stateCueLabel = computed(() => {
  if (props.isUnauthorized) return 'Unauthorized';
  if (props.runtimeStatus === 'error') return 'Degraded';
  return null;
});
const stateCueDetail = computed(() => {
  if (props.isUnauthorized) return 'The runtime REST request was rejected. Re-enter a valid API token.';
  if (props.runtimeStatus === 'error') return props.runtimeModeDetail || 'Runtime reported an error state.';
  return '';
});
const cueClass = computed(() => {
  if (props.isUnauthorized) return 'cue-unauthorized';
  if (props.runtimeStatus === 'error') return 'cue-degraded';
  return 'cue-neutral';
});
</script>

<style scoped>
.workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 48px;
  padding: 0 16px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.header-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  font-family: inherit;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid transparent;
  background: var(--surface-3);
  color: var(--text-muted);
}

.header-chip .status-dot { background: currentColor; }


.ws-connected {
  color: var(--accent);
  border-color: var(--accent);
}
.ws-connecting {
  color: var(--warn);
  border-color: var(--entry-warn-border);
}
.ws-offline {
  color: var(--text-muted);
  border-color: var(--border-strong);
}
.ws-unauthorized {
  color: var(--danger);
  border-color: var(--danger);
}

.rt-running {
  color: var(--accent);
  border-color: var(--accent);
}
.rt-stopped,
.rt-unknown {
  color: var(--text-muted);
  border-color: var(--border-strong);
}
.rt-paused {
  color: var(--warn);
  border-color: var(--entry-warn-border);
}
.rt-error {
  color: var(--danger);
  border-color: var(--danger);
}

.cue-chip.cue-unauthorized,
.cue-chip.cue-degraded {
  color: var(--danger);
  border-color: var(--danger);
}

</style>
