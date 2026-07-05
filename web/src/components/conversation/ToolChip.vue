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
        <div class="detail-facts">
          <div class="detail-fact">
            <span class="detail-label">Action</span>
            <span class="detail-value">{{ display.action }}</span>
          </div>
          <div class="detail-fact">
            <span class="detail-label">Tool</span>
            <code class="detail-value detail-tool">{{ display.toolName }}</code>
          </div>
          <div class="detail-fact">
            <span class="detail-label">Status</span>
            <span class="detail-value" :data-tone="display.statusTone">{{ statusText }}</span>
          </div>
          <div v-if="display.target.length || display.links.length" class="detail-fact">
            <span class="detail-label">Target</span>
            <span class="detail-value detail-target"><InlineParts :parts="detailTarget" /></span>
          </div>
        </div>
        <div v-if="!display.known && display.statusTone !== 'pending'" class="detail-hint">Generic tool — view raw payload for full detail.</div>
      </div>
      <div class="tool-chip-raw-bar">
        <button type="button" class="raw-toggle" :aria-expanded="showRawCall" @click="showRawCall = !showRawCall">{{ showRawCall ? 'Hide raw request' : 'Show raw request' }}</button>
        <button v-if="resultContent !== null" type="button" class="raw-toggle" :aria-expanded="showRawResult" @click="showRawResult = !showRawResult">{{ showRawResult ? 'Hide raw response' : 'Show raw response' }}</button>
      </div>
      <FormattedContent v-if="showRawCall" class="tool-chip-raw" :value="callContent" kind="text" copyable wrap aria-label="Raw tool request" />
      <FormattedContent v-if="showRawResult && resultContent !== null" class="tool-chip-raw" :value="resultContent" kind="text" copyable wrap aria-label="Raw tool response" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import InlineParts from '../content/InlineParts.vue';
import FormattedContent from '../content/FormattedContent.vue';
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
.tool-chip-toggle { display:grid; grid-template-columns: 14px auto minmax(0, 1fr) auto auto; align-items:baseline; gap:8px; flex:1; min-width:0; border:0; padding:3px 0; background:transparent; color:var(--text-muted); cursor:pointer; font:inherit; font-family:'SF Mono',monospace; font-size:12px; text-align:left; border-radius:5px; }
.tool-chip-toggle:hover { background:var(--surface-2); }
.tool-chip-caret { color:var(--text-muted); }
.tool-chip-action { color:var(--accent-2); font-weight:600; }
.tool-chip-target { color:var(--text-muted); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tool-chip-status { justify-self:end; max-width:min(42vw, 520px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-muted); }
.tool-chip-status[data-tone="ok"] { color:var(--accent-2); }
.tool-chip-status[data-tone="error"] { color:var(--danger); }
.tool-chip-status[data-tone="warn"] { color:var(--warn); }
.tool-chip-status[data-tone="pending"] { color:var(--accent); font-style:italic; }
.tool-chip-time { color:var(--text-muted); font-size:11px; white-space:nowrap; }
.tool-chip-pending .tool-chip-action { color:var(--accent); }
.tool-chip-error .tool-chip-action { color:var(--danger); }
.tool-chip-error .tool-chip-toggle { background:var(--entry-danger-bg); }
.tool-chip-links { align-items:baseline; padding:3px 0 3px 8px; font-family:'SF Mono',monospace; font-size:12px; min-width:0; }

.tool-chip-detail { display:flex; flex-direction:column; gap:8px; padding:8px 0 4px 22px; }
.tool-chip-body { display:flex; flex-direction:column; gap:8px; font-size:13px; }
.detail-facts { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:4px 12px; }
.detail-fact { display:flex; flex-direction:column; gap:1px; min-width:0; }
.detail-label { font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.04em; }
.detail-value { color:var(--text); overflow-wrap:anywhere; }
.detail-value[data-tone="ok"] { color:var(--accent-2); }
.detail-value[data-tone="error"] { color:var(--danger); }
.detail-value[data-tone="warn"] { color:var(--warn); }
.detail-value[data-tone="pending"] { color:var(--accent); }
.detail-tool { font-family:'SF Mono',monospace; font-size:12px; color:var(--text-muted); }
.detail-target { font-family:'SF Mono',monospace; font-size:12px; }
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
