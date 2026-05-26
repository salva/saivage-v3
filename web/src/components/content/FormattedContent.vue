<template>
  <JsonView
    v-if="kind === 'json'"
    :value="value"
    :copyable="copyable"
    :max-height="maxHeight"
    :wrap="wrap"
    :aria-label="ariaLabel"
  />
  <MarkdownText v-else-if="kind === 'markdown'" :source="textValue" />
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
  kind?: 'json' | 'markdown' | 'text';
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
</script>
