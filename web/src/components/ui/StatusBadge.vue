<template>
  <span class="status-badge" :class="`tone-${status.tone}`" :title="status.description" :aria-label="ariaLabel">
    <span v-if="showDot" class="status-badge__dot" aria-hidden="true"></span>
    <span>{{ status.label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UiStatus } from '../../utils/status';

const props = withDefaults(defineProps<{ status: UiStatus; showDot?: boolean; ariaLabel?: string }>(), { showDot: false });
const ariaLabel = computed(() => props.ariaLabel ?? `${props.status.label} status`);
</script>

<style scoped>
.status-badge { display: inline-flex; align-items: center; gap:5px; font-size: 11px; font-weight: 600; padding: 2px 10px; border-radius: 10px; text-transform: uppercase; border: 1px solid transparent; white-space: nowrap; }
.status-badge__dot { width:6px; height:6px; border-radius:999px; background:currentColor; }
.tone-neutral { background: var(--surface-3); color: var(--text); border-color: var(--border-strong); }
.tone-active { background: var(--entry-user-bg); color: var(--accent-2); border-color: var(--accent-2); }
.tone-success { background: var(--entry-accent-bg); color: var(--accent); border-color: var(--accent); }
.tone-warning { background: var(--entry-warn-bg); color: var(--warn); border-color: var(--warn); }
.tone-danger { background: var(--entry-danger-bg); color: var(--danger); border-color: var(--danger); }
.tone-pending { background: var(--entry-user-bg); color: var(--accent-2); border-color: var(--accent-2); font-style: italic; }
.tone-stale { background: var(--entry-warn-bg); color: var(--warn); border-color: var(--entry-warn-border); }
.tone-unauthorized { background: var(--entry-danger-bg); color: var(--danger); border-color: var(--danger); }
.tone-offline { background: var(--surface-3); color: var(--text-muted); border-color: var(--border); }
</style>
