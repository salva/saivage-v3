<template>
  <button
    v-if="as === 'button'"
    type="button"
    class="selectable-row"
    :class="rowClasses"
    :disabled="disabled"
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
    :tabindex="disabled ? -1 : 0"
    :aria-disabled="disabled ? 'true' : undefined"
    :aria-current="selected ? 'true' : undefined"
    @click="onDivSelect"
    @keydown.enter.prevent="onDivSelect"
    @keydown.space.prevent="onDivSelect"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Tone } from '../../utils/status';

const props = withDefaults(defineProps<{
  as?: 'button' | 'div';
  selected?: boolean;
  disabled?: boolean;
  tone?: Tone;
}>(), { as: 'button', selected: false, disabled: false, tone: 'neutral' });

const emit = defineEmits<{ select: [] }>();
const rowClasses = computed(() => [`tone-${props.tone}`, { selected: props.selected, disabled: props.disabled }]);

function onDivSelect(): void {
  if (!props.disabled) emit('select');
}
</script>

<style scoped>
.selectable-row { display:flex; align-items:center; gap:6px; width:100%; border:0; background:transparent; color:inherit; text-align:left; font:inherit; cursor:pointer; }
.selectable-row:hover, .selectable-row:focus-visible { background:var(--surface-1); outline:none; }
.selectable-row:focus-visible { box-shadow:inset 0 0 0 1px var(--accent-2); }
.selectable-row.selected { background:var(--entry-user-bg); }
.selectable-row.disabled { cursor:not-allowed; opacity:.6; }
</style>
