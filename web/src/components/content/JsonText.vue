<template>
  <span class="json-text"><template v-if="oversized">{{ text }}</template><template v-else><span v-for="(token, index) in tokens" :key="index" :class="tokenClasses[token.kind]">{{ token.text }}</span></template></span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { JSON_HIGHLIGHT_LIMIT, jsonTokens, type JsonTokenKind } from '../../utils/json-tokens';

const props = defineProps<{ text: string }>();
const oversized = computed(() => props.text.length > JSON_HIGHLIGHT_LIMIT);
const tokens = computed(() => oversized.value ? [] : jsonTokens(props.text));
const tokenClasses: Record<JsonTokenKind, string> = {
  key: 'json-token-key', string: 'json-token-string', number: 'json-token-number',
  boolean: 'json-token-boolean', null: 'json-token-null',
  punctuation: 'json-token-punctuation', plain: 'json-token-plain',
};
</script>

<style scoped>
.json-text { font-family:var(--font-mono); font-size:14px; line-height:1.5; color:var(--text); }
.json-token-key { color:var(--json-key); }
.json-token-string { color:var(--json-string); }
.json-token-number { color:var(--json-number); }
.json-token-boolean { color:var(--json-boolean); }
.json-token-null { color:var(--json-null); }
</style>
