<template>
  <div class="tool-chip" :class="classes" role="group" :aria-label="groupLabel">
    <div class="tool-chip-main">
      <button type="button" class="tool-chip-toggle" :aria-expanded="expanded" :aria-controls="detailsId" :aria-label="toggleLabel" @click="$emit('toggle')">
        <span class="tool-chip-icon" aria-hidden="true">{{ call.icon }}</span>
        <span class="tool-chip-name">{{ call.name }}</span>
        <InlineParts v-if="headline.length" class="tool-chip-headline" :parts="headline" />
        <InlineParts v-if="detail.length" class="tool-chip-tag" :parts="detail" />
        <span v-if="timestamp" class="tool-chip-time">{{ timestamp }}</span>
        <span class="tool-chip-caret" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      </button>
      <InlineParts v-if="interactiveParts.length" class="tool-chip-links" :parts="interactiveParts" />
    </div>
    <div v-if="expanded" :id="detailsId" class="tool-chip-body-stack">
      <FormattedContent class="tool-chip-body" :value="callContent" kind="text" copyable wrap aria-label="Tool call detail" />
      <FormattedContent v-if="resultContent !== null" class="tool-chip-body" :value="resultContent" kind="text" copyable wrap aria-label="Tool result detail" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import InlineParts from '../content/InlineParts.vue';
import FormattedContent from '../content/FormattedContent.vue';
import type { ToolCallPresentation, ToolResultPresentation } from '../../utils/tool-presenters';

const props = defineProps<{
  call: ToolCallPresentation;
  result: ToolResultPresentation | null;
  callContent: string;
  resultContent: string | null;
  status: 'pending' | 'ok' | 'error';
  expanded: boolean;
  detailsId: string;
  timestamp?: string;
}>();

defineEmits<{ (event: 'toggle'): void }>();

const classes = computed(() => ({ 'tool-chip-pending': props.status === 'pending', 'tool-chip-ok': props.status === 'ok', 'tool-chip-error': props.status === 'error', 'tool-call': true, 'tool-result': props.result !== null }));
const headline = computed(() => props.call.headline);
const detail = computed(() => props.result?.headline ?? props.result?.detail ?? props.call.detail ?? []);
const isInteractive = (part: ToolCallPresentation['headline'][number]) => part.kind === 'file' || part.kind === 'url';
const interactiveParts = computed(() => [...headline.value, ...detail.value].filter(isInteractive));
const groupLabel = computed(() => `tool ${props.call.name} ${props.status}`);
const toggleLabel = computed(() => `${props.expanded ? 'Collapse' : 'Expand'} tool ${props.call.name} details`);
</script>

<style scoped>
.tool-chip { display:flex; flex-direction:column; gap:6px; width:100%; }
.tool-chip-main { display:flex; align-items:stretch; width:100%; border:1px solid var(--border); border-radius:10px; background:var(--surface-1); }
.tool-chip-toggle { display:flex; align-items:baseline; gap:8px; flex:1; min-width:0; border:0; border-radius:10px; padding:10px 12px; background:transparent; color:var(--text); cursor:pointer; font:inherit; font-family:'SF Mono',monospace; font-size:12px; text-align:left; }
.tool-chip-toggle:hover { background:var(--surface-3); }
.tool-chip-icon,.tool-chip-name,.tool-chip-time,.tool-chip-caret { flex-shrink:0; }
.tool-chip-name { font-weight:600; color:var(--purple); }
.tool-chip-headline { color:var(--text); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tool-chip-tag,.tool-chip-time { color:var(--text-muted); border:1px solid var(--border); border-radius:999px; padding:1px 8px; font-size:11px; white-space:nowrap; }
.tool-chip-caret { color:var(--text-muted); margin-left:auto; }
.tool-chip-links { align-items:center; padding:0 12px 0 0; font-family:'SF Mono',monospace; font-size:12px; }
.tool-chip-ok .tool-chip-name { color:var(--accent); }
.tool-chip-error .tool-chip-main { border-color:var(--danger); }
.tool-chip-error .tool-chip-name,.tool-chip-error .tool-chip-headline { color:var(--danger); }
.tool-chip-body-stack { display:flex; flex-direction:column; gap:6px; }
</style>
