<template>
  <header class="workspace-header">
    <div class="header-left">
      <h1 class="section-title">{{ sectionTitle }}</h1>
      <span v-if="projectName" class="project-name">{{ projectName }}</span>
    </div>

    <div class="header-right">
      <!-- WebSocket connection indicator -->
      <span
        class="status-chip ws-chip"
        :class="`ws-${connectionState}`"
        :title="wsTooltip"
      >
        <span class="chip-dot"></span>
        {{ wsLabel }}
      </span>

      <!-- Runtime status chip -->
      <span
        v-if="runtimeStatus"
        class="status-chip"
        :class="`rt-${runtimeStatus}`"
        :title="runtimeTooltip"
      >
        <span class="chip-dot"></span>
        {{ runtimeStatusLabel }}
      </span>

      <!-- Global pause chip -->
      <button
        v-if="isPaused !== null"
        class="status-chip pause-chip"
        :class="{ paused: isPaused }"
        :title="isPaused ? 'Runtime is paused — click to resume' : 'Click to pause runtime'"
        @click="togglePause"
      >
        <span class="chip-icon">{{ isPaused ? '⏸' : '▶' }}</span>
        {{ isPaused ? 'PAUSED' : 'LIVE' }}
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
  isPaused: boolean | null;
}>();

const emit = defineEmits<{
  'toggle-pause': [];
}>();

const wsLabel = computed(() => {
  const labels: Record<string, string> = {
    connected: 'WS LIVE',
    connecting: 'WS CONNECTING',
    offline: 'WS OFFLINE',
    unauthorized: 'WS UNAUTH',
  };
  return labels[props.connectionState] ?? 'WS ?';
});

const wsTooltip = computed(() => {
  const tooltips: Record<string, string> = {
    connected: 'WebSocket connected — live updates active',
    connecting: 'WebSocket connecting...',
    offline: 'WebSocket offline — no live updates',
    unauthorized: 'WebSocket unauthorized — check API token',
  };
  return tooltips[props.connectionState] ?? '';
});

const runtimeTooltip = computed(() => {
  if (!props.runtimeStatus) return '';
  return `Runtime: ${props.runtimeStatusLabel}`;
});

function togglePause(): void {
  emit('toggle-pause');
}
</script>

<style scoped>
.workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
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

.chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.chip-icon {
  font-size: 10px;
}

/* WebSocket states */
.ws-connected {
  color: #3fb950;
  border-color: #238636;
}
.ws-connecting {
  color: #d29922;
  border-color: #9e6a03;
}
.ws-offline {
  color: #8b949e;
  border-color: #484f58;
}
.ws-unauthorized {
  color: #f85149;
  border-color: #da3633;
}

/* Runtime states */
.rt-running {
  color: #3fb950;
  border-color: #238636;
}
.rt-idle {
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
.rt-unknown {
  color: #8b949e;
}

/* Pause chip */
.pause-chip {
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s;
  color: #3fb950;
  border-color: #238636;
}

.pause-chip.paused {
  color: #d29922;
  border-color: #9e6a03;
}

.pause-chip:hover {
  filter: brightness(1.2);
}
</style>
