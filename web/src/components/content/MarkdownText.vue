<template>
  <div class="markdown-text" v-html="rendered" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const props = defineProps<{ source: string }>();

const marked = new Marked({ gfm: true, breaks: false });

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/]/g, '\\]');
}

function replaceCardRefsOutsideInlineCode(segment: string): string {
  const parts = segment.split(/(`+)/);
  let inCode = false;
  return parts.map((part) => {
    if (/^`+$/.test(part)) {
      inCode = !inCode;
      return part;
    }
    if (inCode) return part;
    return part.replace(/\[\[card:([^\]|\s]+)(?:\|([^\]]*))?\]\]/g, (_match, encodedId: string, fallback: string | undefined) => {
      let id: string;
      try { id = decodeURIComponent(encodedId); } catch { return _match; }
      if (!id) return _match;
      const label = escapeMarkdownLinkText(fallback ?? id);
      const href = `/cards/${encodeURIComponent(id)}`;
      return `[${label}](${href})`;
    });
  }).join('');
}

function transformCardRefs(source: string): string {
  let inFence = false;
  return source.split('\n').map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : replaceCardRefsOutsideInlineCode(line);
  }).join('\n');
}

const rendered = computed(() => {
  const source = props.source ?? '';
  if (source.length === 0) return '';
  const html = marked.parse(transformCardRefs(source), { async: false }) as string;
  return DOMPurify.sanitize(html);
});
</script>

<style scoped>
.markdown-text {
  display: block;
  font-size: 13px;
  line-height: 1.5;
}

.markdown-text :deep(p) { margin: 0 0 0.5em; }
.markdown-text :deep(p:last-child) { margin-bottom: 0; }
.markdown-text :deep(pre) {
  background: var(--surface-2, rgba(110, 118, 129, 0.12));
  border-radius: 6px;
  padding: 8px 10px;
  overflow-x: auto;
  font-family: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;
  font-size: 0.92em;
  margin: 0.5em 0;
}
.markdown-text :deep(code) {
  background: rgba(110, 118, 129, 0.18);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.markdown-text :deep(pre code) {
  background: transparent;
  padding: 0;
  border-radius: 0;
}
.markdown-text :deep(table) {
  border-collapse: collapse;
  margin: 0.5em 0;
  font-size: 0.95em;
}
.markdown-text :deep(th),
.markdown-text :deep(td) {
  border: 1px solid var(--surface-3, rgba(110, 118, 129, 0.3));
  padding: 4px 8px;
  text-align: left;
}
.markdown-text :deep(th) {
  background: var(--surface-2, rgba(110, 118, 129, 0.08));
  font-weight: 600;
}
.markdown-text :deep(ul),
.markdown-text :deep(ol) {
  margin: 0.25em 0 0.5em;
  padding-left: 1.5em;
}
.markdown-text :deep(blockquote) {
  border-left: 3px solid var(--surface-3, rgba(110, 118, 129, 0.3));
  padding-left: 8px;
  margin: 0.5em 0;
  color: var(--text-muted, #888);
}
.markdown-text :deep(a) {
  color: var(--accent, #4ea1ff);
  text-decoration: underline;
}
</style>
