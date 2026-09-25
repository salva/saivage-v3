<template>
  <span class="exact-value">
    <span class="exact-value__text mono" :title="value">{{ display }}</span>
    <button
      type="button"
      class="exact-value__copy"
      :aria-label="`Copy ${label}`"
      @click="copy"
    >{{ copied ? 'Copied' : 'Copy' }}</button>
    <span class="visually-hidden" aria-live="polite">{{ copied ? 'Copied' : '' }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { compactUuid } from '../../utils/legibility';

const props = defineProps<{
  value: string;
  label?: string;
  truncate?: boolean;
}>();

const copied = ref(false);
let resetTimer: ReturnType<typeof setTimeout> | null = null;

const display = computed(() => (props.truncate ? compactUuid(props.value) : props.value));

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.value);
    copied.value = true;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    copied.value = false;
  }
}
</script>

<style scoped>
.exact-value { display: inline-flex; align-items: baseline; gap: 4px; min-width: 0; }
.exact-value__text { font-size: 11px; color: var(--text-muted); overflow-wrap: anywhere; }
.exact-value__copy {
  border: none; background: none; padding: 0 2px; cursor: pointer;
  font: inherit; font-size: 10px; color: var(--text-muted);
  text-decoration: underline;
}
.exact-value__copy:hover { color: var(--text); }
.exact-value__copy:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 1px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
