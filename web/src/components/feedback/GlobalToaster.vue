<template>
  <div class="global-toaster" aria-live="polite" aria-atomic="true">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="toast"
      :class="`toast-${toast.tone}`"
      :role="toast.tone === 'danger' ? 'alert' : 'status'"
      @mouseenter="pauseToast(toast.id)"
      @mouseleave="scheduleToast(toast)"
    >
      <div class="toast-body">
        <strong class="toast-title">{{ toast.title }}</strong>
        <span v-if="toast.message" class="toast-message">{{ toast.message }}</span>
      </div>
      <button class="toast-close" type="button" :aria-label="`Dismiss ${toast.title}`" @click="dismissToast(toast.id)">×</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useFeedbackStore, type FeedbackToast } from '../../stores/feedback';

const feedback = useFeedbackStore();
const { toasts } = storeToRefs(feedback);
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function pauseToast(id: string): void {
  const timer = timers.get(id);
  if (!timer) return;
  clearTimeout(timer);
  timers.delete(id);
}

function dismissToast(id: string): void {
  pauseToast(id);
  feedback.dismiss(id);
}

function scheduleToast(toast: FeedbackToast): void {
  pauseToast(toast.id);
  const timeout = toast.autoDismissMs ?? 4000;
  if (timeout <= 0) return;
  timers.set(toast.id, setTimeout(() => dismissToast(toast.id), timeout));
}

watch(toasts, (items) => {
  const ids = new Set(items.map((toast) => toast.id));
  for (const id of [...timers.keys()]) {
    if (!ids.has(id)) pauseToast(id);
  }
  for (const toast of items) {
    if (!timers.has(toast.id)) scheduleToast(toast);
  }
}, { immediate: true });

onUnmounted(() => {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
});
</script>

<style scoped>
.global-toaster { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 1000; pointer-events: none; }
.toast { display:flex; align-items:flex-start; gap:10px; min-width:240px; max-width:420px; background: rgba(22,27,34,0.96); border: 1px solid var(--border); color: var(--text); padding: 10px 12px; border-radius: 8px; box-shadow: 0 6px 18px rgba(0,0,0,0.3); pointer-events:auto; }
.toast-danger { border-color: var(--danger); }
.toast-warning { border-color: var(--warn); }
.toast-success { border-color: var(--accent); }
.toast-body { display:flex; flex-direction:column; gap:3px; min-width:0; }
.toast-title { font-size:13px; }
.toast-message { color:var(--text-muted); font-size:12px; line-height:1.4; }
.toast-close { border:0; background:transparent; color:var(--text-muted); cursor:pointer; font-size:18px; line-height:1; margin-left:auto; }
.toast-close:hover { color:var(--text); }
</style>
