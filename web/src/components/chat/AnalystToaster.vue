<template>
  <div class="analyst-toaster" role="status" aria-live="polite" aria-atomic="true">
    <div v-for="toast in toasts" :key="toast.id" class="toast">{{ toast.label }}</div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { useWsStore } from '../../stores/ws';

interface ToastItem { id: string; label: string; }

const wsStore = useWsStore();
const toasts = ref<ToastItem[]>([]);
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function removeToast(id: string): void {
  toasts.value = toasts.value.filter((item) => item.id !== id);
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

const unsubscribe = wsStore.onType('activity', (envelope) => {
  if (envelope.content?.event !== 'control_action_recorded') return;
  if (envelope.content?.actor !== 'analyst' || envelope.content?.surface !== 'web-chat') return;
  const action = typeof envelope.content?.action === 'string' ? envelope.content.action : 'action';
  const targetId = typeof envelope.content?.target_id === 'string' ? envelope.content.target_id : 'unknown';
  const id = typeof envelope.content?.id === 'string' ? envelope.content.id : `${Date.now()}`;
  const item = { id, label: `Analyst ${action} on ${targetId}` };
  toasts.value = [...toasts.value, item].slice(-3);
  const timer = setTimeout(() => removeToast(id), 4000);
  timers.set(id, timer);
});

onUnmounted(() => {
  unsubscribe();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
});
</script>

<style scoped>
.analyst-toaster { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 1000; pointer-events: none; }
.toast { background: rgba(22,27,34,0.96); border: 1px solid #30363d; color: #f0f6fc; padding: 10px 12px; border-radius: 8px; box-shadow: 0 6px 18px rgba(0,0,0,0.3); }
</style>
