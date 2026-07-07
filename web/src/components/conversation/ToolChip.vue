<template>
  <div class="tool-chip tool-call" :class="[statusClass, { 'tool-result': resultContent !== null }]" role="group" :aria-label="groupLabel">
    <div class="tool-chip-main">
      <button type="button" class="tool-chip-toggle" :aria-expanded="expanded" :aria-controls="detailsId" :aria-label="toggleLabel" @click="$emit('toggle')">
        <span class="tool-chip-caret" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
        <strong class="tool-chip-action">{{ display.action }}</strong>
        <span v-if="display.target.length" class="tool-chip-target"><InlineParts :parts="display.target" /></span>
        <span v-if="display.status.length" class="tool-chip-status" :data-tone="display.statusTone"><InlineParts :parts="display.status" /></span>
        <span v-if="timestamp" class="tool-chip-time" :title="timeTitle">{{ formattedTimestamp }}</span>
      </button>
      <InlineParts v-if="display.links.length" class="tool-chip-links" :parts="display.links" />
    </div>
    <div v-if="expanded" :id="detailsId" class="tool-chip-detail">
      <div class="tool-chip-body">
        <dl class="tool-chip-fields">
          <div class="tool-chip-field">
            <dt>Tool</dt>
            <dd><code>{{ display.toolName }}</code></dd>
          </div>
          <div class="tool-chip-field">
            <dt>Status</dt>
            <dd :data-tone="display.statusTone">{{ statusText }}</dd>
          </div>
          <div v-if="display.target.length || display.links.length" class="tool-chip-field">
            <dt>Target</dt>
            <dd><InlineParts :parts="detailTarget" /></dd>
          </div>
        </dl>
        <div v-if="!display.known && display.statusTone !== 'pending'" class="detail-hint">Generic tool — view raw payload for full detail.</div>
      </div>
      <div class="tool-chip-raw-bar">
        <button type="button" class="raw-toggle" :aria-expanded="showRawCall" @click="showRawCall = !showRawCall">{{ showRawCall ? 'Hide raw request' : 'Show raw request' }}</button>
        <button v-if="resultContent !== null" type="button" class="raw-toggle" :aria-expanded="showRawResult" @click="showRawResult = !showRawResult">{{ showRawResult ? 'Hide raw response' : 'Show raw response' }}</button>
      </div>
      <CodeBlock v-if="showRawCall" class="tool-chip-raw" :code="callContent" language="text" copyable wrap aria-label="Raw tool request" />
      <CodeBlock v-if="showRawResult && resultContent !== null" class="tool-chip-raw" :code="resultContent" language="text" copyable wrap aria-label="Raw tool response" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import InlineParts from '../content/InlineParts.vue';
import CodeBlock from '../content/CodeBlock.vue';
import type { ToolDisplayModel } from '../../utils/tool-friendly';
import { formatTimestamp, isRecentTimestamp, timestampTitle as absoluteTimestampTitle } from '../../utils/timestamp';

const props = defineProps<{
  display: ToolDisplayModel;
  callContent: string;
  resultContent: string | null;
  expanded: boolean;
  detailsId: string;
  timestamp?: string;
}>();

defineEmits<{ (event: 'toggle'): void }>();

const statusClass = computed(() => {
  if (props.display.statusTone === 'pending') return 'tool-chip-pending';
  if (props.display.statusTone === 'error') return 'tool-chip-error';
  return 'tool-chip-ok';
});
const detailTarget = computed(() => [...props.display.target, ...props.display.links]);
const groupLabel = computed(() => `tool ${props.display.toolName} ${props.display.statusTone}`);
const toggleLabel = computed(() => `${props.expanded ? 'Collapse' : 'Expand'} tool ${props.display.toolName} details`);
const formattedTimestamp = computed(() => props.timestamp ? formatTimestamp(props.timestamp, isRecentTimestamp(props.timestamp) ? 'relative' : 'absolute') : '');
const timeTitle = computed(() => props.timestamp ? absoluteTimestampTitle(props.timestamp) : '');
const statusText = computed(() => {
  if (props.display.status.length) return inlineText(props.display.status);
  if (props.display.statusTone === 'pending') return 'running…';
  if (props.display.statusTone === 'error') return 'errored';
  return 'ok';
});

function inlineText(parts: ToolDisplayModel['target']): string {
  return parts.map((part) => {
    if (part.kind === 'text') return part.text;
    if (part.kind === 'code') return part.code;
    if (part.kind === 'file') return part.label ?? part.path;
    if (part.kind === 'url') return part.label ?? part.href;
    return part.fallbackLabel ?? part.id;
  }).join('').trim();
}

const showRawCall = ref(false);
const showRawResult = ref(false);

watch(() => props.expanded, (open) => { if (!open) { showRawCall.value = false; showRawResult.value = false; } });
watch(() => props.callContent, () => { showRawCall.value = false; });
watch(() => props.resultContent, () => { showRawResult.value = false; });
</script>

<style scoped>
.tool-chip { display:flex; flex-direction:column; gap:2px; width:100%; }
.tool-chip-main { display:flex; align-items:stretch; width:100%; }
.tool-chip-toggle { display:grid; grid-template-columns: 14px auto minmax(0, 1fr) auto auto; align-items:baseline; gap:8px; flex:1; min-width:0; border:0; padding:4px 6px; background:transparent; color:var(--text-muted); cursor:pointer; font:inherit; font-size:12px; text-align:left; border-radius:var(--radius-sm); }
.tool-chip-toggle:hover { background:var(--surface-2); }
.tool-chip-caret { color:var(--text-muted); }
.tool-chip-action { color:var(--accent-2); font-weight:600; }
.tool-chip-target { color:var(--text-muted); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tool-chip-status { justify-self:end; max-width:min(42vw, 520px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-muted); border:1px solid var(--border); border-radius:var(--radius-pill); background:var(--surface-2); padding:1px 8px; line-height:1.35; }
.tool-chip-status[data-tone="ok"] { color:var(--accent-2); border-color:var(--entry-accent-border); background:var(--entry-accent-bg); }
.tool-chip-status[data-tone="error"] { color:var(--danger); border-color:var(--entry-danger-border); background:var(--entry-danger-bg); }
.tool-chip-status[data-tone="warn"] { color:var(--warn); border-color:var(--entry-warn-border); background:var(--entry-warn-bg); }
.tool-chip-status[data-tone="pending"] { color:var(--accent); border-color:var(--entry-accent-border); background:var(--entry-accent-bg); font-style:italic; }
.tool-chip-time { color:var(--text-muted); font-size:11px; white-space:nowrap; }
.tool-chip-pending .tool-chip-action { color:var(--accent); }
.tool-chip-error .tool-chip-action { color:var(--danger); }
.tool-chip-error .tool-chip-toggle { background:var(--entry-danger-bg); }
.tool-chip-links { align-items:baseline; padding:3px 0 3px 8px; font-size:12px; min-width:0; }

.tool-chip-detail { display:flex; flex-direction:column; gap:8px; background:var(--surface-1); border-left:2px solid var(--surface-3); border-radius:0 var(--radius-sm) var(--radius-sm) 0; padding:8px 12px; margin:4px 0 4px 22px; }
.tool-chip-pending .tool-chip-detail { border-left-color:var(--accent); background:var(--entry-accent-bg); }
.tool-chip-error .tool-chip-detail { border-left-color:var(--danger); background:var(--entry-danger-bg); }
.tool-chip-body { display:flex; flex-direction:column; gap:8px; font-size:13px; }
.tool-chip-fields { display:flex; flex-direction:column; gap:4px; margin:0; }
.tool-chip-field { display:flex; align-items:baseline; gap:8px; min-width:0; }
.tool-chip-field dt { color:var(--text-muted); font-size:var(--font-size-sm); flex-shrink:0; }
.tool-chip-field dd { min-width:0; color:var(--text); overflow-wrap:anywhere; margin:0; }
.tool-chip-field dd[data-tone="ok"] { color:var(--accent-2); }
.tool-chip-field dd[data-tone="error"] { color:var(--danger); }
.tool-chip-field dd[data-tone="warn"] { color:var(--warn); }
.tool-chip-field dd[data-tone="pending"] { color:var(--accent); }
.tool-chip-field code { font-family:'SF Mono',monospace; font-size:12px; color:var(--text-muted); }
.detail-hint { font-size:11px; color:var(--text-muted); font-style:italic; }

.tool-chip-raw-bar { display:flex; gap:8px; flex-wrap:wrap; }
.raw-toggle { border:1px solid var(--border); background:transparent; color:var(--text-muted); border-radius:4px; padding:2px 8px; font:inherit; font-size:11px; cursor:pointer; }
.raw-toggle:hover { color:var(--text); border-color:var(--border-strong); }
.raw-toggle[aria-expanded="true"] { color:var(--accent-2); border-color:var(--accent-2); }
.tool-chip-raw { border-left:2px solid var(--surface-3); padding-left:10px; }

@media (max-width: 720px) {
  .tool-chip-toggle { grid-template-columns: 14px auto auto; }
  .tool-chip-target { grid-column: 2 / -1; }
  .tool-chip-status { justify-self:start; }
}
</style>
