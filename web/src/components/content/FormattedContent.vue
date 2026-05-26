<template>
  <JsonView
    v-if="resolvedKind === 'json'"
    :value="jsonValue"
    :copyable="copyable"
    :max-height="maxHeight"
    :wrap="wrap"
    :aria-label="ariaLabel"
  />
  <MarkdownText v-else-if="resolvedKind === 'markdown'" :source="textValue" />
  <CodeBlock
    v-else
    :code="textValue"
    language="text"
    :copyable="copyable"
    :max-height="maxHeight"
    :wrap="wrap"
    :aria-label="ariaLabel"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import CodeBlock from './CodeBlock.vue';
import JsonView from './JsonView.vue';
import MarkdownText from './MarkdownText.vue';

const props = withDefaults(defineProps<{
  value: unknown;
  kind?: 'json' | 'markdown' | 'text' | 'auto';
  copyable?: boolean;
  maxHeight?: string;
  wrap?: boolean;
  ariaLabel?: string;
}>(), {
  kind: 'text',
  copyable: false,
  maxHeight: '60vh',
  wrap: false,
  ariaLabel: undefined,
});

const textValue = computed(() => typeof props.value === 'string' ? props.value : String(props.value ?? ''));
const parsedStringJson = computed(() => {
  if (typeof props.value !== 'string') return null;
  const trimmed = props.value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try { return JSON.parse(trimmed) as unknown; } catch { return null; }
});
const resolvedKind = computed(() => {
  if (props.kind !== 'auto') return props.kind;
  if (parsedStringJson.value !== null || (props.value !== null && typeof props.value === 'object')) return 'json';
  return 'markdown';
});
const jsonValue = computed(() => parsedStringJson.value ?? props.value);
</script>
