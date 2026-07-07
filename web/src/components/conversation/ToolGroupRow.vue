<template>
  <div class="tool-group" role="group" :aria-label="groupLabel">
    <button type="button" class="tool-group-toggle" :aria-expanded="open" :aria-controls="bodyId" @click="$emit('toggle', group.id)">
      <span class="tool-group-caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      <strong class="tool-group-label">{{ group.label }}</strong>
      <span class="tool-group-summary">{{ group.summary }}</span>
    </button>
    <div v-if="open" :id="bodyId" class="tool-group-body">
      <ToolChip
        v-for="pair in group.pairs"
        :key="pair.call.id"
        :display="buildToolDisplay(pair)"
        :call-content="pair.call.content"
        :result-content="pair.result?.content ?? null"
        :expanded="expandedIds.has(pair.call.id)"
        :details-id="`tool-${pair.call.id}`"
        :timestamp="pair.call.timestamp"
        @toggle="$emit('toggle', pair.call.id)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ToolGroup } from '../../utils/agent-timeline';
import { buildToolDisplay } from '../../utils/tool-friendly';
import ToolChip from './ToolChip.vue';

const props = defineProps<{
  group: ToolGroup;
  expandedIds: Set<string>;
}>();

defineEmits<{ (event: 'toggle', id: string): void }>();

const open = computed(() => props.expandedIds.has(props.group.id));
const bodyId = computed(() => `${props.group.id}:body`);
const groupLabel = computed(() => `${props.group.label}: ${props.group.summary}`);
</script>

<style scoped>
.tool-group { display:flex; flex-direction:column; gap:4px; }
.tool-group-toggle { display:flex; align-items:baseline; gap:8px; width:100%; border:0; padding:4px 6px; background:transparent; cursor:pointer; font:inherit; font-size:12px; text-align:left; border-radius:var(--radius-sm); color:var(--text-muted); }
.tool-group-toggle:hover { background:var(--surface-2); }
.tool-group-caret { color:var(--text-muted); }
.tool-group-label { color:var(--text); font-weight:600; }
.tool-group-summary { color:var(--text-muted); border:1px solid var(--border); border-radius:var(--radius-pill); background:var(--surface-2); padding:0 8px; line-height:1.35; }
.tool-group-body { display:flex; flex-direction:column; gap:2px; padding-left:14px; border-left:2px solid var(--surface-3); margin-left:4px; }
</style>
