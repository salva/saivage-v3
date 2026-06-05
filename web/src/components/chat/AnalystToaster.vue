<template>
  <div class="analyst-toaster" role="status" aria-live="polite" aria-atomic="true">
    <div v-for="toast in toasts" :key="toast.id" class="toast">{{ toast.label }}</div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useAnalystChat } from '../../stores/analystChat';

const analystChat = useAnalystChat();
const { toasts } = storeToRefs(analystChat);
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function removeToast(id: string): void {
  analystChat.removeToast(id);
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

watch(toasts, (items) => {
  for (const item of items) {
    if (timers.has(item.id)) continue;
    const timer = setTimeout(() => removeToast(item.id), 4000);
    timers.set(item.id, timer);
  }
}, { immediate: true });

onUnmounted(() => {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
});
</script>

<style scoped>
.analyst-toaster { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 1000; pointer-events: none; }
.toast { background: rgba(22,27,34,0.96); border: 1px solid var(--border); color: var(--text); padding: 10px 12px; border-radius: 8px; box-shadow: 0 6px 18px rgba(0,0,0,0.3); }
</style>
