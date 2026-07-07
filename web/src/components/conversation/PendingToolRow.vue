<template>
  <div class="pending-tool-row" role="group" :aria-label="`pending tool ${tool}`">
    <button type="button" class="pending-toggle tool-chip-toggle" :aria-expanded="expanded" :aria-controls="detailsId" :aria-label="toggleLabel" @click="$emit('toggle')">
      <span class="tool-chip-caret" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      <strong class="tool-chip-action">{{ action }}</strong>
      <span class="pending-summary">{{ summary }}</span>
      <span class="pending-status"><span class="thinking-dot" aria-hidden="true"></span>running…</span>
    </button>
    <div v-if="expanded" :id="detailsId" class="pending-detail">
      <dl class="tool-chip-fields">
        <div class="tool-chip-field">
          <dt>Tool</dt>
          <dd><code>{{ tool }}</code></dd>
        </div>
        <div class="tool-chip-field">
          <dt>Status</dt>
          <dd data-tone="pending">running…</dd>
        </div>
        <div v-if="summary" class="tool-chip-field">
          <dt>Summary</dt>
          <dd>{{ summary }}</dd>
        </div>
      </dl>
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
.pending-toggle { display:grid; grid-template-columns: 14px auto minmax(0,1fr) auto; align-items:baseline; gap:8px; border:0; padding:4px 6px; background:transparent; cursor:pointer; font:inherit; font-size:12px; text-align:left; color:var(--text-muted); border-radius:var(--radius-sm); }
.pending-toggle:hover { background:var(--surface-2); }
.tool-chip-caret { color:var(--text-muted); }
.tool-chip-action { color:var(--accent); font-weight:600; }
.pending-summary { color:var(--text-muted); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pending-status { color:var(--accent); font-style:italic; display:inline-flex; align-items:center; gap:6px; border:1px solid var(--entry-accent-border); border-radius:var(--radius-pill); background:var(--entry-accent-bg); padding:1px 8px; line-height:1.35; }
.thinking-dot { width:6px; height:6px; border-radius:999px; background:currentColor; animation:thinking-pulse 1s ease-in-out infinite; }
@keyframes thinking-pulse { 0%,100%{opacity:.35;transform:scale(.85)} 50%{opacity:1;transform:scale(1)} }
.pending-detail { display:flex; flex-direction:column; gap:8px; background:var(--entry-accent-bg); border-left:2px solid var(--accent); border-radius:0 var(--radius-sm) var(--radius-sm) 0; padding:8px 12px; margin:4px 0 4px 22px; font-size:13px; }
.tool-chip-fields { display:flex; flex-direction:column; gap:4px; margin:0; }
.tool-chip-field { display:flex; align-items:baseline; gap:8px; min-width:0; }
.tool-chip-field dt { color:var(--text-muted); font-size:var(--font-size-sm); flex-shrink:0; }
.tool-chip-field dd { min-width:0; color:var(--text); overflow-wrap:anywhere; margin:0; }
.tool-chip-field dd[data-tone="pending"] { color:var(--accent); }
.tool-chip-field code { font-family:'SF Mono',monospace; font-size:12px; color:var(--text-muted); }
</style>
