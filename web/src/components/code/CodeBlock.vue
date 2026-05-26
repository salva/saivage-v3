<template>
  <div class="code-block" :class="{ 'code-block--wrap': wrap }">
    <button
      v-if="copyable"
      type="button"
      class="code-block__copy"
      :title="copied ? 'Copied' : 'Copy'"
      @click="onCopy"
    >{{ copied ? 'copied' : 'copy' }}</button>
    <div
      v-if="oversized"
      class="code-block__notice highlighting-disabled"
    >Syntax highlighting disabled (&gt;1 MB)</div>
    <pre
      :class="['code-block__pre', `language-${resolvedLanguage}`, 'hljs']"
      :style="preStyle"
      :aria-label="ariaLabel"
    ><code
      v-if="oversized"
      class="code-block__code"
      v-text="code"
    /><code
      v-else
      class="code-block__code"
      v-html="highlightedHtml"
    /></pre>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { highlight } from '../../utils/highlight';

const props = withDefaults(defineProps<{
  code: string;
  language?: 'json' | 'bash' | 'diff' | 'typescript' | 'text';
  copyable?: boolean;
  maxHeight?: string;
  wrap?: boolean;
  ariaLabel?: string;
}>(), {
  language: 'text',
  copyable: false,
  maxHeight: '60vh',
  wrap: false,
  ariaLabel: undefined,
});

const SIZE_LIMIT = 1_000_000;
const copied = ref(false);

const oversized = computed(() => (props.code?.length ?? 0) > SIZE_LIMIT);

const resolvedLanguage = computed(() => {
  if (props.language === 'text' || !props.language) return 'plaintext';
  return props.language;
});

const highlightedHtml = computed(() => {
  if (oversized.value) return '';
  return highlight(props.code ?? '', resolvedLanguage.value);
});

const preStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {
    maxHeight: props.maxHeight ?? '60vh',
    whiteSpace: props.wrap ? 'pre-wrap' : 'pre',
  };
  return style;
});

async function onCopy(): Promise<void> {
  const text = props.code ?? '';
  let ok = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      ok = true;
    } else {
      ok = legacyCopy(text);
    }
  } catch {
    ok = legacyCopy(text);
  }
  if (ok) {
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1200);
  }
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}
</script>

<style scoped>
.code-block {
  position: relative;
  background: var(--bg);
  color: var(--text);
  border-radius: 6px;
  font-family: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;
  font-size: 12.5px;
  overflow: hidden;
}

.code-block__pre {
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  line-height: 1.45;
}

.code-block__code {
  font-family: inherit;
  font-size: inherit;
  background: transparent;
  color: inherit;
  white-space: inherit;
}

.code-block--wrap .code-block__pre {
  word-break: break-word;
}

.code-block__copy {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(110, 118, 129, 0.2);
  color: var(--text);
  border: 1px solid rgba(240, 246, 252, 0.1);
  border-radius: 4px;
  padding: 2px 8px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  z-index: 1;
}

.code-block__copy:hover {
  background: rgba(110, 118, 129, 0.35);
}

.code-block__notice {
  padding: 6px 12px;
  font-size: 11.5px;
  color: var(--text-muted);
  background: rgba(110, 118, 129, 0.12);
  border-bottom: 1px solid rgba(240, 246, 252, 0.06);
}
</style>
