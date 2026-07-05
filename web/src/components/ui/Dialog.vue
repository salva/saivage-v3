<template>
  <Teleport to="body">
    <Transition :name="transitionName">
      <div v-if="visible" ref="overlayRef" class="ui-dialog-overlay" @mousedown="onOverlayMouseDown">
        <section
          ref="dialogRef"
          class="ui-dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          @keydown="onDialogKeydown"
          @mousedown.stop
        >
          <slot />
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{ visible: boolean; titleId: string; transitionName?: string }>(), { transitionName: 'modal' });
const emit = defineEmits<{ dismiss: [] }>();

const overlayRef = ref<HTMLElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);
let bodyModalOpenCount = 0;
let previousFocus: Element | null = null;
let inertedSiblings: HTMLElement[] = [];

function focusableElements(): HTMLElement[] {
  const root = dialogRef.value;
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.hasAttribute('disabled') && el.tabIndex >= 0);
}

function syncModalOpenFlag(isOpen: boolean): void {
  bodyModalOpenCount = isOpen ? bodyModalOpenCount + 1 : Math.max(0, bodyModalOpenCount - 1);
  document.body.toggleAttribute('data-modal-open', bodyModalOpenCount > 0);
}

function setBackgroundInert(): void {
  const overlay = overlayRef.value;
  if (!overlay) return;
  inertedSiblings = [...document.body.children]
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child !== overlay && !child.hasAttribute('inert'));
  for (const sibling of inertedSiblings) sibling.setAttribute('inert', '');
}

function clearBackgroundInert(): void {
  for (const sibling of inertedSiblings) sibling.removeAttribute('inert');
  inertedSiblings = [];
}

async function openDialog(): Promise<void> {
  previousFocus = document.activeElement;
  syncModalOpenFlag(true);
  await nextTick();
  setBackgroundInert();
  const first = focusableElements()[0] ?? dialogRef.value;
  first?.focus();
}

function closeDialogSideEffects(): void {
  syncModalOpenFlag(false);
  clearBackgroundInert();
  if (previousFocus instanceof HTMLElement && document.contains(previousFocus)) previousFocus.focus();
  previousFocus = null;
}

watch(() => props.visible, (visible, wasVisible) => {
  if (visible === wasVisible) return;
  if (visible) void openDialog();
  else closeDialogSideEffects();
}, { immediate: true });

onBeforeUnmount(() => {
  if (props.visible) closeDialogSideEffects();
});

function onOverlayMouseDown(event: MouseEvent): void {
  if (event.target === event.currentTarget) emit('dismiss');
}

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('dismiss');
    return;
  }
  if (event.key !== 'Tab') return;
  const elements = focusableElements();
  if (elements.length === 0) {
    event.preventDefault();
    dialogRef.value?.focus();
    return;
  }
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<style scoped>
.ui-dialog-overlay { position:fixed; inset:0; background:rgba(0, 0, 0, 0.6); display:flex; align-items:center; justify-content:center; z-index:1000; }
.ui-dialog { outline:none; max-width:100vw; max-height:100vh; }
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s ease; }
.modal-enter-from, .modal-leave-to { opacity:0; }
</style>
