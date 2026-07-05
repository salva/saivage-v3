<template>
  <div class="pending-tool-row" role="group" :aria-label="`pending tool ${tool}`">
    <button type="button" class="pending-toggle tool-chip-toggle" :aria-expanded="expanded" :aria-controls="detailsId" :aria-label="toggleLabel" @click="$emit('toggle')">
      <span class="tool-chip-caret" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      <strong class="tool-chip-action">{{ action }}</strong>
      <span class="pending-summary">{{ summary }}</span>
      <span class="pending-status"><span class="thinking-dot" aria-hidden="true"></span>running…</span>
    </button>
    <div v-if="expanded" :id="detailsId" class="pending-detail">
      <div class="detail-fact"><span class="detail-label">Tool</span><code class="detail-value">{{ tool }}</code></div>
      <div class="detail-fact"><span class="detail-label">Status</span><span class="detail-value" data-tone="pending">running…</span></div>
      <div v-if="summary" class="detail-fact"><span class="detail-label">Summary</span><span class="detail-value">{{ summary }}</span></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { friendlyAction } from '../../utils/tool-friendly';

const props = defineProps<{ tool: string; summary: string; expanded: boolean; detailsId: string }>();
defineEmits<{ (event: 'toggle'): void }>();

const action = computed(() => friendlyAction(props.tool));
const toggleLabel = computed(() => `${props.expanded ? 'Collapse' : 'Expand'} pending ${props.tool}`);
</script>

<style scoped>
.pending-tool-row { display:flex; flex-direction:column; gap:2px; }
.pending-toggle { display:grid; grid-template-columns: 14px auto minmax(0,1fr) auto; align-items:baseline; gap:8px; border:0; padding:3px 0; background:transparent; cursor:pointer; font:inherit; font-family:'SF Mono',monospace; font-size:12px; text-align:left; color:var(--text-muted); border-radius:5px; }
.pending-toggle:hover { background:var(--surface-2); }
.tool-chip-caret { color:var(--text-muted); }
.tool-chip-action { color:var(--accent); font-weight:600; }
.pending-summary { color:var(--text-muted); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pending-status { color:var(--accent); font-style:italic; display:inline-flex; align-items:center; gap:6px; }
.thinking-dot { width:6px; height:6px; border-radius:999px; background:currentColor; animation:thinking-pulse 1s ease-in-out infinite; }
@keyframes thinking-pulse { 0%,100%{opacity:.35;transform:scale(.85)} 50%{opacity:1;transform:scale(1)} }
.pending-detail { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:4px 12px; padding:8px 0 4px 22px; font-size:13px; }
.detail-fact { display:flex; flex-direction:column; gap:1px; min-width:0; }
.detail-label { font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.04em; }
.detail-value { color:var(--text); overflow-wrap:anywhere; }
.detail-value[data-tone="pending"] { color:var(--accent); }
</style>
