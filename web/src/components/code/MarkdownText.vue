<template>
  <div class="markdown-text">
    <template v-for="(seg, idx) in segments" :key="idx">
      <CodeBlock
        v-if="seg.kind === 'code'"
        :code="seg.content"
        :language="resolveLanguage(seg.language)"
      />
      <code
        v-else-if="seg.kind === 'inline-code'"
        class="inline-token"
      >{{ seg.content }}</code>
      <span
        v-else
        class="md-text"
      >{{ seg.content }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import CodeBlock from './CodeBlock.vue';
import { splitMarkdownSegments } from '../../utils/markdown';

const props = defineProps<{ source: string }>();

const segments = computed(() => splitMarkdownSegments(props.source ?? ''));

const SUPPORTED = new Set(['json', 'bash', 'diff', 'typescript', 'text']);

function resolveLanguage(lang?: string): 'json' | 'bash' | 'diff' | 'typescript' | 'text' {
  if (lang && SUPPORTED.has(lang)) {
    return lang as 'json' | 'bash' | 'diff' | 'typescript' | 'text';
  }
  return 'text';
}
</script>

<style scoped>
.markdown-text {
  display: block;
}

.md-text {
  white-space: pre-wrap;
}

.inline-token {
  background: rgba(110, 118, 129, 0.18);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;
  font-size: 0.92em;
  color: #c9d1d9;
}
</style>
