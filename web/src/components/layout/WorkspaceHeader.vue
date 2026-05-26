<template>
  <header class="workspace-header">
    <div class="header-left">
      <h1 class="section-title">{{ sectionTitle }}</h1>
      <span v-if="projectName" class="project-name">{{ projectName }}</span>
    </div>

    <div class="header-right">
      <span
        class="status-chip ws-chip"
        :class="`ws-${connectionState}`"
        :title="liveUpdateDetail"
      >
        <span class="chip-dot"></span>
        {{ liveUpdateLabel || wsLabel }}
      </span>

      <span
        class="status-chip runtime-chip"
        :class="runtimeChipClass"
        :title="runtimeChipTitle"
      >
        <span class="chip-dot"></span>
        {{ runtimeModeLabel || runtimeStatusLabel }}
      </span>

      <span v-if="stateCueLabel" class="status-chip cue-chip" :class="cueClass" :title="stateCueDetail">
        <span class="chip-dot"></span>
        {{ stateCueLabel }}
      </span>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, unref } from 'vue';
import type { WsConnectionState } from '../../api/types';

const props = defineProps<{
  sectionTitle: string;
  projectName?: string;
  connectionState: WsConnectionState;
  runtimeStatus: string | null;
  runtimeStatusLabel: string;
  liveUpdateLabel?: string;
  liveUpdateDetail?: string;
  runtimeModeLabel?: string;
  runtimeModeDetail?: string;
  isStale?: boolean;
  isUnauthorized?: boolean;
  hasToken?: boolean;
}>();

const wsLabel = computed(() => {
  const labels: Record<string, string> = {
    connected: 'WS LIVE',
    connecting: 'WS CONNECTING',
    offline: 'WS OFFLINE',
    'no-token': 'NO TOKEN',
    unauthorized: 'WS UNAUTH',
  };
  return labels[props.connectionState] ?? 'WS ?';
});

const runtimeChipClass = computed(() => `rt-${props.runtimeStatus || 'unknown'}`);
const runtimeChipTitle = computed(() => {
  const detail = String(unref(props.runtimeModeDetail) || 'Runtime status is observable here; use Dashboard → Runtime Console for execution controls.');
  if (detail.includes('Runtime Console')) return detail;
  return `${detail} Use Dashboard → Runtime Console for execution controls.`;
});
const stateCueLabel = computed(() => {
  if (!props.hasToken) return 'Docs public / API locked';
  if (props.isUnauthorized) return 'Unauthorized';
  if (props.isStale) return 'Stale snapshot';
  if (props.runtimeStatus === 'frozen') return 'Frozen';
  if (props.runtimeStatus === 'error') return 'Degraded';
  return null;
});
const stateCueDetail = computed(() => {
  if (!props.hasToken) return 'API token affects API and WebSocket access only. Public docs remain available at /docs/.';
  if (props.isUnauthorized) return 'API and WebSocket access were rejected. Re-enter a valid token.';
  if (props.isStale) return 'You are viewing an older runtime snapshot. Refresh to resync authoritative REST state.';
  if (props.runtimeStatus === 'frozen') return props.runtimeModeDetail || 'Runtime is frozen and needs operator attention.';
  if (props.runtimeStatus === 'error') return props.runtimeModeDetail || 'Runtime reported an error state.';
  return '';
});
const cueClass = computed(() => {
  if (!props.hasToken) return 'cue-no-token';
  if (props.isUnauthorized) return 'cue-unauthorized';
  if (props.isStale) return 'cue-stale';
  if (props.runtimeStatus === 'frozen') return 'cue-frozen';
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

.project-name {
  font-size: 12px;
  color: var(--text-muted);
  padding: 2px 8px;
  background: var(--surface-3);
  border-radius: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.status-chip {
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


.chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}


.ws-connected {
  color: var(--accent);
  border-color: var(--accent);
}
.ws-connecting {
  color: var(--warn);
  border-color: var(--entry-warn-border);
}
.ws-offline,
.ws-no-token {
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
.rt-idle,
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
.rt-frozen {
  color: var(--accent-2);
  border-color: var(--accent-2);
}

.cue-chip.cue-no-token,
.cue-chip.cue-stale {
  color: var(--warn);
  border-color: var(--entry-warn-border);
}
.cue-chip.cue-unauthorized,
.cue-chip.cue-degraded {
  color: var(--danger);
  border-color: var(--danger);
}
.cue-chip.cue-frozen {
  color: var(--accent-2);
  border-color: var(--accent-2);
}

</style>
