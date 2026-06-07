<template>
  <button type="button" class="card-ref-link" :class="`mode-${mode}`" :title="titleText" @click="$emit('navigate', refView.id)">
    <span class="card-ref-primary">{{ primaryLabel }}</span>
    <span v-if="secondaryLabel" class="card-ref-secondary">{{ secondaryLabel }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CardRefView } from '../../api/types';

export type CardRefMode = 'current' | 'historicalSnapshot' | 'debugRaw';

const props = withDefaults(defineProps<{ refView: CardRefView; mode?: CardRefMode }>(), { mode: 'current' });
defineEmits<{ navigate: [id: string] }>();

const primaryLabel = computed(() => {
  if (props.mode === 'debugRaw') return props.refView.id;
  if (props.refView.missing) return `${props.refView.id} (missing)`;
  return props.refView.display_path ?? props.refView.title ?? props.refView.id;
});

const secondaryLabel = computed(() => {
  if (props.mode === 'debugRaw') return props.refView.display_path ?? props.refView.title ?? '';
  return props.refView.title && props.refView.title !== primaryLabel.value ? props.refView.title : '';
});

const titleText = computed(() => {
  const parts = [props.refView.id];
  if (props.refView.display_path) parts.push(props.refView.display_path);
  if (props.refView.title) parts.push(props.refView.title);
  if (props.refView.missing) parts.push('missing');
  return parts.join(' · ');
});
</script>

<style scoped>
.card-ref-link { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; background:var(--surface-3); border:1px solid var(--border); color:var(--text); border-radius:4px; cursor:pointer; font:inherit; }
.card-ref-primary { font-family:'SF Mono',monospace; color:var(--accent-2); }
.card-ref-secondary { color:var(--text-muted); font-size:12px; }
.mode-debugRaw .card-ref-primary { color:var(--text); }
</style>
