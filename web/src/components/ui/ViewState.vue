<template>
  <div class="view-state" :class="`tone-${resolvedTone}`" :role="role">
    <div class="view-state__text">
      <strong class="view-state__title">{{ title }}</strong>
      <span v-if="message" class="view-state__message">{{ message }}</span>
    </div>
    <div v-if="$slots.action" class="view-state__action"><slot name="action" /></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Tone } from '../../utils/status';

type ViewStateKind = 'loading' | 'empty' | 'error' | 'unauthorized' | 'stale';
const props = defineProps<{ state: ViewStateKind; title: string; message?: string; tone?: Tone }>();
const resolvedTone = computed<Tone>(() => props.tone ?? ({ loading: 'pending', empty: 'neutral', error: 'danger', unauthorized: 'unauthorized', stale: 'stale' } satisfies Record<ViewStateKind, Tone>)[props.state]);
const role = computed(() => resolvedTone.value === 'danger' || resolvedTone.value === 'unauthorized' ? 'alert' : 'status');
</script>

<style scoped>
.view-state { display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap; font-size:13px; color:var(--text-muted); }
.view-state__text { display:flex; flex-direction:column; gap:3px; }
.view-state__title { color:var(--text); }
.view-state__message { color:inherit; }
.view-state__action { font-size:12px; }
.tone-danger .view-state__title, .tone-danger .view-state__message { color:var(--danger); }
.tone-unauthorized .view-state__title, .tone-unauthorized .view-state__message { color:var(--danger); }
.tone-stale .view-state__title, .tone-stale .view-state__message, .tone-warning .view-state__title, .tone-warning .view-state__message { color:var(--warn); }
</style>
