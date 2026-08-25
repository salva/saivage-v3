<template>
  <button
    v-if="as === 'button'"
    type="button"
    class="selectable-row"
    :class="rowClasses"
    :aria-current="selected ? 'true' : undefined"
    @click="emit('select')"
  >
    <slot />
  </button>
  <div
    v-else
    class="selectable-row"
    :class="rowClasses"
    role="button"
    :tabindex="0"
    :aria-current="selected ? 'true' : undefined"
    @click="emit('select')"
    @keydown.enter.prevent="emit('select')"
    @keydown.space.prevent="emit('select')"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  as?: 'button' | 'div';
  selected?: boolean;
}>(), { as: 'button', selected: false });

const emit = defineEmits<{ select: [] }>();
const rowClasses = computed(() => [{ selected: props.selected }]);
</script>

<style scoped>
.selectable-row { display:flex; align-items:center; gap:6px; width:100%; border:0; background:transparent; color:inherit; text-align:left; font:inherit; cursor:pointer; }
.selectable-row:hover, .selectable-row:focus-visible { background:var(--surface-1); outline:none; }
.selectable-row:focus-visible { box-shadow:inset 0 0 0 1px var(--accent-2); }
.selectable-row.selected { background:var(--entry-user-bg); }
</style>
