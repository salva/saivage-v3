<template>
  <div class="status-banner" :class="`tone-${tone}`" :role="role">
    <div class="status-banner__body">
      <strong v-if="title" class="status-banner__title">{{ title }}</strong>
      <span class="status-banner__message">{{ message }}</span>
    </div>
    <div v-if="$slots.action" class="status-banner__action"><slot name="action" /></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Tone } from '../../utils/status';

const props = defineProps<{ tone: Tone; title?: string; message: string }>();
const role = computed(() => props.tone === 'danger' || props.tone === 'unauthorized' ? 'alert' : 'status');
</script>

<style scoped>
.status-banner { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; border-radius:8px; padding:10px 12px; font-size:13px; border:1px solid transparent; }
.status-banner__body { display:flex; flex-direction:column; gap:3px; min-width:0; }
.status-banner__title { font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
.status-banner__message { color:inherit; }
.status-banner__action { flex:0 0 auto; }
.tone-neutral { background:var(--surface-2); color:var(--text); border-color:var(--border); }
.tone-active { background:var(--entry-user-bg); color:var(--accent-2); border-color:var(--accent-2); }
.tone-success { background:var(--entry-accent-bg); color:var(--accent); border-color:var(--accent); }
.tone-warning, .tone-stale { background:var(--entry-warn-bg); color:var(--warn); border-color:var(--entry-warn-border); }
.tone-danger, .tone-unauthorized { background:var(--entry-danger-bg); color:var(--danger); border-color:var(--danger); }
.tone-pending { background:var(--entry-user-bg); color:var(--accent-2); border-color:var(--accent-2); }
</style>
