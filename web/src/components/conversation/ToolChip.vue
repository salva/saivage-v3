<template>
  <div class="tool-chip" :class="classes" role="group" :aria-label="groupLabel">
    <div class="tool-chip-main">
      <button
        type="button"
        class="tool-chip-toggle"
        :aria-expanded="expanded"
        :aria-label="toggleLabel"
        @click="handleToggle"
      >
        <span class="tool-chip-icon" aria-hidden="true">{{ presentation.icon }}</span>
        <span class="tool-chip-name">{{ presentation.name }}</span>
        <InlineParts v-if="buttonHeadline.length" class="tool-chip-headline" :parts="buttonHeadline" />
        <InlineParts v-if="buttonDetail.length" class="tool-chip-tag" :parts="buttonDetail" />
        <span class="tool-chip-caret" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      </button>
      <InlineParts v-if="interactiveParts.length" class="tool-chip-links" :parts="interactiveParts" />
    </div>
    <FormattedContent
      v-if="expanded"
      class="tool-chip-body"
      :value="presentation.body"
      :kind="presentation.bodyKind"
      copyable
      wrap
      aria-label="Tool detail"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import InlineParts from '../content/InlineParts.vue';
import FormattedContent from '../content/FormattedContent.vue';
import type { ToolCallPresentation, ToolResultPresentation } from '../../utils/tool-presenters';

const props = defineProps<{
  presentation: ToolCallPresentation | ToolResultPresentation;
  expanded: boolean;
  variant: 'call' | 'ok' | 'error';
  labelPrefix: string;
}>();

const emit = defineEmits<{ (event: 'toggle'): void }>();

function handleToggle(): void {
  emit('toggle');
}

const classes = computed(() => ({
  'tool-chip-call': props.variant === 'call',
  'tool-chip-ok': props.variant === 'ok',
  'tool-chip-error': props.variant === 'error',
}));
function partText(part: ToolCallPresentation['headline'][number]): string {
  if (part.kind === 'text') return part.text;
  if (part.kind === 'file') return part.label ?? part.path;
  if (part.kind === 'url') return part.label ?? part.href;
  return part.code;
}
const isInteractive = (part: ToolCallPresentation['headline'][number]) => part.kind === 'file' || part.kind === 'url';
const buttonHeadline = computed(() => props.presentation.headline.filter((part) => !isInteractive(part)));
const buttonDetail = computed(() => (props.presentation.detail ?? []).filter((part) => !isInteractive(part)));
const interactiveParts = computed(() => [...props.presentation.headline, ...(props.presentation.detail ?? [])].filter(isInteractive));
const headlineText = computed(() => props.presentation.headline.map(partText).join(' '));
const action = computed(() => props.expanded ? 'Collapse' : 'Expand');
const toggleLabel = computed(() => `${action.value} ${props.labelPrefix} details: ${props.presentation.icon} ${props.presentation.name} ${headlineText.value}`.trim());
const groupLabel = computed(() => `${props.labelPrefix}: ${props.presentation.name}`);
</script>

<style scoped>
.tool-chip { display:flex; flex-direction:column; gap:6px; width:100%; }
.tool-chip-main { display:flex; align-items:stretch; width:100%; border:1px solid var(--border); border-radius:10px; background:var(--surface-1); }
.tool-chip-toggle { display:flex; align-items:baseline; gap:8px; flex:1; min-width:0; border:0; border-radius:10px; padding:10px 12px; background:transparent; color:var(--text); cursor:pointer; font:inherit; font-family:'SF Mono',monospace; font-size:12px; text-align:left; }
.tool-chip-toggle:hover { background:var(--surface-3); }
.tool-chip-icon { font-size:13px; flex-shrink:0; }
.tool-chip-name { font-weight:600; color:var(--purple); flex-shrink:0; }
.tool-chip-headline { color:var(--text); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tool-chip-tag { color:var(--text-muted); border:1px solid var(--border); border-radius:999px; padding:1px 8px; font-size:11px; white-space:nowrap; }
.tool-chip-caret { color:var(--text-muted); margin-left:auto; flex-shrink:0; }
.tool-chip-links { align-items:center; padding:0 12px 0 0; font-family:'SF Mono',monospace; font-size:12px; }
.tool-chip-ok .tool-chip-name { color:var(--accent); }
.tool-chip-error .tool-chip-main { border-color:var(--danger); }
.tool-chip-error .tool-chip-name,.tool-chip-error .tool-chip-headline { color:var(--danger); }
.tool-chip-body { margin-top:2px; }
</style>
