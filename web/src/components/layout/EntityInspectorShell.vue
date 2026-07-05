<template>
  <div class="entity-inspector-shell" :class="selected ? 'has-selection' : 'no-selection'">
    <aside class="entity-inspector-shell__list" :aria-label="listLabel">
      <slot name="list" />
    </aside>

    <section ref="detailRef" class="entity-inspector-shell__detail" :aria-label="detailLabel" tabindex="-1">
      <div v-if="selected" class="entity-inspector-shell__detail-header detail-header-bar">
        <Button class="back-btn" size="sm" variant="ghost" @click="emit('back')">{{ backLabel }}</Button>
        <span v-if="detailTitle" class="entity-inspector-shell__detail-title">{{ detailTitle }}</span>
      </div>
      <slot v-if="selected" name="detail" />
      <ViewState v-else class="entity-inspector-shell__empty" state="empty" :title="emptyTitle" :message="emptyMessage" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import Button from '../ui/Button.vue';
import ViewState from '../ui/ViewState.vue';

const props = withDefaults(defineProps<{
  selected: boolean;
  listLabel: string;
  detailLabel: string;
  emptyTitle: string;
  emptyMessage?: string;
  backLabel?: string;
  detailTitle?: string | null;
}>(), {
  emptyMessage: '',
  backLabel: 'Back to list',
  detailTitle: null,
});

const emit = defineEmits<{ back: [] }>();
const detailRef = ref<HTMLElement | null>(null);

watch(() => props.selected, async (selected) => {
  if (!selected) return;
  await nextTick();
  detailRef.value?.focus({ preventScroll: true });
});
</script>

<style scoped>
.entity-inspector-shell { display:grid; grid-template-columns:minmax(280px,36%) minmax(0,1fr); height:100%; min-height:0; }
.entity-inspector-shell__list { display:flex; flex-direction:column; min-height:0; border-right:1px solid var(--border); background:var(--bg); overflow:hidden; }
.entity-inspector-shell__detail { min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; outline:none; }
.entity-inspector-shell__detail-header { display:none; align-items:center; gap:12px; padding:8px 16px; background:var(--surface-1); border-bottom:1px solid var(--border); flex-shrink:0; }
.entity-inspector-shell__detail-title { font-size:11px; color:var(--border-strong); font-family:'SF Mono',monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.entity-inspector-shell__empty { display:flex; align-items:center; justify-content:center; height:100%; }

@media (max-width:880px) {
  .entity-inspector-shell { grid-template-columns:1fr; }
  .entity-inspector-shell.has-selection .entity-inspector-shell__list { display:none; }
  .entity-inspector-shell.no-selection .entity-inspector-shell__detail { display:none; }
  .entity-inspector-shell__detail-header { display:flex; }
}
</style>
