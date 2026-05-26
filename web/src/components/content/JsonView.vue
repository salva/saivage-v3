<template>
  <CodeBlock
    :code="formatted"
    language="json"
    :copyable="copyable"
    :max-height="maxHeight"
    :wrap="wrap"
    :aria-label="ariaLabel"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import CodeBlock from './CodeBlock.vue';
import { formatJson } from '../../utils/format-json';

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

const formatted = computed(() => formatJson(props.value));
</script>
