<template>
  <span v-if="missing" class="entity-link entity-link--missing" :title="titleText" :aria-label="ariaLabel">
    <span class="entity-link__primary">{{ primaryLabel }}</span>
    <span v-if="secondaryLabel" class="entity-link__secondary">{{ secondaryLabel }}</span>
  </span>
  <RouterLink v-else class="entity-link" :to="to" :title="titleText" :aria-label="ariaLabel">
    <span class="entity-link__primary">{{ primaryLabel }}</span>
    <span v-if="secondaryLabel" class="entity-link__secondary">{{ secondaryLabel }}</span>
  </RouterLink>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';

type EntityKind = 'card' | 'agent' | 'file' | 'process';

const props = withDefaults(defineProps<{
  kind: EntityKind;
  id: string;
  label?: string | null;
  title?: string | null;
  missing?: boolean;
}>(), { label: null, title: null, missing: false });

const primaryLabel = computed(() => props.label || props.title || props.id);
const secondaryLabel = computed(() => props.title && props.title !== primaryLabel.value ? props.title : '');
const titleText = computed(() => [props.kind, props.id, props.title, props.missing ? 'missing' : ''].filter(Boolean).join(' · '));
const ariaLabel = computed(() => `${props.missing ? 'Missing ' : ''}${props.kind} ${primaryLabel.value}`);
const to = computed<RouteLocationRaw>(() => {
  if (props.kind === 'card') return { name: 'card-detail', params: { id: props.id } };
  if (props.kind === 'agent') return { name: 'agent-detail', params: { id: props.id } };
  if (props.kind === 'process') return { name: 'process-detail', params: { id: props.id } };
  return { name: 'files', query: { path: props.id } };
});
</script>

<style scoped>
.entity-link { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; background:var(--surface-3); border:1px solid var(--border); color:var(--text); border-radius:4px; font:inherit; text-decoration:none; }
.entity-link:not(.entity-link--missing) { cursor:pointer; }
.entity-link:not(.entity-link--missing):hover { border-color:var(--border-strong); background:var(--surface-2); }
.entity-link--missing { opacity:.68; border-style:dashed; }
.entity-link__primary { font-family:'SF Mono',monospace; color:var(--accent-2); }
.entity-link--missing .entity-link__primary { color:var(--text-muted); }
.entity-link__secondary { color:var(--text-muted); font-size:12px; }
</style>
