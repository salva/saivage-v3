<template>
  <section class="compaction-progress" role="status" data-testid="compaction-progress">
    <strong>Compacting history — {{ progress.folds_done }} summary calls completed</strong>
    <span>{{ progress.fold_in_flight ? 'Summary call in flight' : 'Preparing or publishing compacted history' }}</span>
    <span>Elapsed {{ elapsed }}</span>
    <span v-if="lastKnown">Last-known progress; the latest detail refresh failed.</span>
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { AgentSession } from '../../api/types';

const props = defineProps<{ progress: NonNullable<AgentSession['compaction']>; lastKnown: boolean }>();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
const elapsed = computed(() => {
  const seconds = Math.max(0, Math.floor((now.value - Date.parse(props.progress.started_at)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
});
function stopTimer(): void { if (timer !== null) { clearInterval(timer); timer = null; } }
watch(() => props.progress.started_at, () => {
  stopTimer();
  now.value = Date.now();
  timer = setInterval(() => { now.value = Date.now(); }, 1000);
}, { immediate: true });
onUnmounted(stopTimer);
</script>

<style scoped>
.compaction-progress { display: grid; gap: 3px; margin: 10px 16px 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); font-size: 12px; }
.compaction-progress span { color: var(--text-muted); }
</style>
