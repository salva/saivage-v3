<template>
  <header class="workspace-header">
    <div class="header-left">
      <h1 class="section-title">{{ sectionTitle }}</h1>
      <span v-if="projectName" class="project-name">{{ projectName }}</span>
    </div>

    <div class="header-right">
      <button
        class="status-chip analyst-chip"
        type="button"
        :title="analystButtonTitle"
        :aria-label="analystButtonTitle"
        :aria-expanded="analystDrawerOpen"
        aria-controls="analyst-chat-panel"
        @click="emit('toggle-analyst')"
      >
        <span class="chip-icon">💬</span>
        Analyst
      </button>

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
        :title="runtimeModeDetail"
      >
        <span class="chip-dot"></span>
        {{ runtimeModeLabel || runtimeStatusLabel }}
      </span>

      <span v-if="stateCueLabel" class="status-chip cue-chip" :class="cueClass" :title="stateCueDetail">
        <span class="chip-dot"></span>
        {{ stateCueLabel }}
      </span>

      <button
        v-if="isPaused !== null"
        class="status-chip pause-chip"
        :class="{ paused: isPaused, disabled: Boolean(pauseDisabledReason) }"
        :title="pauseTitle"
        :disabled="Boolean(pauseDisabledReason)"
        @click="togglePause"
      >
        <span class="chip-icon">{{ isPaused ? '▶' : '⏸' }}</span>
        {{ isPaused ? 'Resume' : 'Pause' }}
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue';
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
  isPaused: boolean | null;
  isStale?: boolean;
  isUnauthorized?: boolean;
  hasToken?: boolean;
  pauseDisabledReason?: string | null;
  analystDrawerOpen?: boolean;
}>();

const emit = defineEmits<{
  'toggle-pause': [];
  'toggle-analyst': [];
}>();

const analystButtonTitle = 'Open persistent analyst chat (Ctrl/Cmd+J)';
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
const pauseTitle = computed(() => {
  if (props.pauseDisabledReason) return props.pauseDisabledReason;
  return props.isPaused ? 'Runtime is paused — click to resume' : 'Pause runtime';
});

function togglePause(): void {
  if (props.pauseDisabledReason) return;
  emit('toggle-pause');
}
</script>

<style scoped>
.workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 48px;
  padding: 0 16px;
  background: #161b22;
  border-bottom: 1px solid #30363d;
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
  color: #f0f6fc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-name {
  font-size: 12px;
  color: #8b949e;
  padding: 2px 8px;
  background: #21262d;
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
  background: #21262d;
  color: #8b949e;
}

.analyst-chip {
  cursor: pointer;
  color: #79c0ff;
  border-color: #1f6feb;
}

.chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.chip-icon {
  font-size: 10px;
}

.ws-connected {
  color: #3fb950;
  border-color: #238636;
}
.ws-connecting {
  color: #d29922;
  border-color: #9e6a03;
}
.ws-offline,
.ws-no-token {
  color: #8b949e;
  border-color: #484f58;
}
.ws-unauthorized {
  color: #f85149;
  border-color: #da3633;
}

.rt-running {
  color: #3fb950;
  border-color: #238636;
}
.rt-idle,
.rt-unknown {
  color: #8b949e;
  border-color: #484f58;
}
.rt-paused {
  color: #d29922;
  border-color: #9e6a03;
}
.rt-error {
  color: #f85149;
  border-color: #da3633;
}
.rt-frozen {
  color: #79c0ff;
  border-color: #1f6feb;
}

.cue-chip.cue-no-token,
.cue-chip.cue-stale {
  color: #d29922;
  border-color: #9e6a03;
}
.cue-chip.cue-unauthorized,
.cue-chip.cue-degraded {
  color: #f85149;
  border-color: #da3633;
}
.cue-chip.cue-frozen {
  color: #79c0ff;
  border-color: #1f6feb;
}

.pause-chip {
  cursor: pointer;
  transition: all 0.15s;
  color: #3fb950;
  border-color: #238636;
}

.pause-chip.paused {
  color: #d29922;
  border-color: #9e6a03;
}

.pause-chip.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.pause-chip:hover:not(:disabled),
.analyst-chip:hover {
  filter: brightness(1.2);
}
</style>
