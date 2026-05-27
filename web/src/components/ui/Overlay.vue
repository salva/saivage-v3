<template>
  <Transition :name="transitionName">
    <div v-if="visible" class="ui-overlay" @click="onOverlayClick">
      <slot />
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';

const props = withDefaults(defineProps<{ visible: boolean; transitionName?: string }>(), { transitionName: 'modal' });
const emit = defineEmits<{ dismiss: [] }>();

let bodyModalOpenCount = 0;

function syncModalOpenFlag(isOpen: boolean): void {
  if (isOpen) {
    bodyModalOpenCount += 1;
  } else {
    bodyModalOpenCount = Math.max(0, bodyModalOpenCount - 1);
  }
  document.body.toggleAttribute('data-modal-open', bodyModalOpenCount > 0);
}

watch(() => props.visible, (visible, wasVisible) => {
  if (visible === wasVisible) return;
  syncModalOpenFlag(visible);
}, { immediate: true });

onBeforeUnmount(() => {
  if (props.visible) syncModalOpenFlag(false);
});

function onOverlayClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) emit('dismiss');
}
</script>

<style scoped>
.ui-overlay { position:fixed; inset:0; background:rgba(0, 0, 0, 0.6); display:flex; align-items:center; justify-content:center; z-index:1000; }
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s ease; }
.modal-enter-from, .modal-leave-to { opacity:0; }
</style>
