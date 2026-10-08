<template>
  <div class="tool-chip" :data-tool-entry-id="entryId" role="group" :aria-label="`tool ${display.toolName}`">
    <div class="tool-chip-main">
      <button type="button" class="tool-chip-toggle" :aria-expanded="expanded" :aria-controls="detailsId" :aria-label="`${expanded ? 'Collapse' : 'Expand'} tool ${display.toolName} details`" @click="$emit('toggle')">
        <strong class="tool-chip-action"><span aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span> {{ display.action }}</strong>
        <span class="tool-chip-target"><InlineParts :parts="display.target" /></span>
        <span class="tool-chip-status" :data-tone="display.statusTone"><InlineParts :parts="display.status" /></span>
      </button>
      <InlineParts v-if="display.links.length" class="tool-chip-links" :parts="display.links" />
    </div>
    <span v-if="interveningEntries" class="later-result">Result recorded later</span>
    <div v-if="expanded" :id="detailsId" class="tool-chip-detail">
      <p>Tool <code>{{ display.toolName }}</code></p>
      <p v-if="interveningEntries">{{ interveningEntries }} retained entries between request and result. The result was not necessarily known at the intervening entries.</p>
      <section v-if="callContent !== null" :data-entry-id="entryId" class="tool-request" tabindex="-1">
        <h4>Request</h4><p class="provenance">{{ requestProvenance }}</p>
        <ToolSemanticSection v-for="(section, index) in display.requestSections" :key="index" :section="section" />
        <details class="safe-original"><summary>Safe original request</summary><CodeBlock :code="callContent" language="json" max-height="none" copyable wrap aria-label="Safe original tool request" /></details>
      </section>
      <p v-else>Requested context unavailable</p>
      <section v-if="resultContent !== null" :data-entry-id="resultEntryId ?? entryId" class="tool-result" tabindex="-1">
        <h4>Result</h4><p class="provenance">{{ resultProvenance }}</p>
        <ToolSemanticSection v-for="(section, index) in display.resultSections" :key="index" :section="section" />
        <details class="safe-original"><summary>Safe original result</summary><CodeBlock :code="resultContent" language="json" max-height="none" copyable wrap aria-label="Safe original tool result" /></details>
      </section>
      <p v-else>No result recorded</p>
    </div>
  </div>
</template>
<script setup lang="ts">
import InlineParts from '../content/InlineParts.vue';
import CodeBlock from '../content/CodeBlock.vue';
import ToolSemanticSection from './ToolSemanticSection.vue';
import type { ToolDisplayModel } from '../../utils/tool-friendly';
defineProps<{
  entryId: string; resultEntryId?: string; display: ToolDisplayModel;
  callContent: string | null; resultContent: string | null;
  expanded: boolean; detailsId: string;
  requestProvenance?: string; resultProvenance?: string; interveningEntries?: number;
}>();
defineEmits<{ (event: 'toggle'): void }>();
</script>
<style scoped>
.tool-chip { width:100%; min-width:0; color:var(--text); font-size:15px; line-height:1.5; }
.tool-chip-main { display:flex; flex-wrap:wrap; align-items:baseline; min-width:0; }
.tool-chip-toggle { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; flex:1 1 18rem; min-width:0; max-width:100%; border:0; padding:6px; background:transparent; color:var(--text); cursor:pointer; font:inherit; text-align:left; border-radius:4px; }
.tool-chip-toggle:hover { background:var(--surface-2); }
.tool-chip-toggle:focus-visible, summary:focus-visible { outline:2px solid var(--text); outline-offset:2px; }
.tool-chip-action { color:var(--text); flex:0 0 auto; max-width:100%; overflow-wrap:anywhere; }
.tool-chip-target { flex:1 1 8rem; min-width:min(8rem,100%); max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tool-chip-status { flex:0 1 auto; max-width:100%; overflow-wrap:anywhere; }
.tool-chip-status[data-tone="error"] { color:var(--danger); }
.tool-chip-links { padding:6px; overflow-wrap:anywhere; }
.later-result { display:block; padding-left:24px; }
.tool-chip-detail { margin:6px 0 6px 16px; padding:12px; border-left:2px solid var(--border-strong); background:var(--surface-1); overflow-wrap:anywhere; }
.tool-chip-detail p { margin:4px 0; }
.tool-chip-detail h4 { margin:12px 0 4px; font-size:15px; }
.provenance { overflow-wrap:anywhere; }
summary { cursor:pointer; }
.tool-chip :deep(.inline-parts) { flex-wrap:wrap; min-width:0; max-width:100%; }
.tool-chip-target :deep(.inline-parts) { display:inline; white-space:nowrap; }
.tool-chip-target :deep(.inline-part) { white-space:nowrap; overflow-wrap:normal; }
</style>
