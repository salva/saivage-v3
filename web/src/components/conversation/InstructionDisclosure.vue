<template>
  <details class="instruction-disclosure">
    <summary>{{ label }}</summary>
    <p>{{ explanation }} · privacy-filtered recorded instructions</p>
    <CodeBlock :code="text" language="text" copyable wrap max-height="none" :aria-label="label" />
  </details>
</template>
<script setup lang="ts">
import CodeBlock from '../content/CodeBlock.vue';
defineProps<{ label: string; text: string; explanation: string }>();
</script>
<style scoped>
.instruction-disclosure { border-left:3px solid var(--accent-2); background:var(--surface-2); padding:8px 12px; color:var(--text); overflow-wrap:anywhere; }
summary { cursor:pointer; font-weight:600; }
p { font-size:15px; line-height:1.5; }
.instruction-disclosure :deep(pre) { white-space:pre-wrap; overflow:visible; overflow-wrap:anywhere; }
.instruction-disclosure :deep(.code-block--copyable) { padding-top:32px; }
</style>
