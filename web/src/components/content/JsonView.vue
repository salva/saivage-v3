<template>
  <CodeBlock
    v-if="formatted.length > maxHighlightedBytes"
    :code="formatted"
    language="json"
    :copyable="copyable"
    :max-height="maxHeight"
    :wrap="wrap"
    :aria-label="ariaLabel"
  />
  <pre
    v-else
    class="json-token-view"
    :style="{ maxHeight, whiteSpace: wrap ? 'pre-wrap' : 'pre' }"
    :aria-label="ariaLabel"
  ><template v-for="(token, index) in tokens" :key="index"><span :class="`json-token json-token-${token.kind}`">{{ token.text }}</span></template></pre>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import CodeBlock from './CodeBlock.vue';
import { formatJson } from '../../utils/format-json';
import { tokenizeJson } from '../../utils/json-tokenize';

const props = withDefaults(defineProps<{
  value: unknown;
  copyable?: boolean;
  maxHeight?: string;
  wrap?: boolean;
  ariaLabel?: string;
}>(), {
  copyable: false,
  maxHeight: '60vh',
  wrap: false,
  ariaLabel: undefined,
});

const maxHighlightedBytes = 1_000_000;
const formatted = computed(() => formatJson(props.value));
const tokens = computed(() => tokenizeJson(formatted.value));
</script>

<style scoped>
.json-token-view { margin:0; overflow:auto; padding:12px; border-radius:8px; background:var(--surface-2); color:var(--text); font-family:'SF Mono',monospace; font-size:12px; line-height:1.5; }
.json-token-key { color:var(--accent-2); }
.json-token-string { color:var(--success); }
.json-token-number { color:var(--warn); }
.json-token-literal { color:var(--purple); }
.json-token-punctuation { color:var(--text-muted); }
</style>
