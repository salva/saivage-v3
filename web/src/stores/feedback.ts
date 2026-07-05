import { ref } from 'vue';
import { defineStore } from 'pinia';

export type FeedbackTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface FeedbackToast {
  id: string;
  tone: FeedbackTone;
  title: string;
  message?: string;
  autoDismissMs?: number;
}

function toastId(): string {
  return `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const useFeedbackStore = defineStore('feedback', () => {
  const toasts = ref<FeedbackToast[]>([]);

  function notify(toast: Omit<FeedbackToast, 'id'> & { id?: string }): string {
    const id = toast.id ?? toastId();
    toasts.value = [...toasts.value.filter((item) => item.id !== id), { ...toast, id }].slice(-3);
    return id;
  }

  function notifyError(title: string, message?: string): string {
    return notify({ tone: 'danger', title, message, autoDismissMs: 8000 });
  }

  function dismiss(id: string): void {
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  function clear(): void {
    toasts.value = [];
  }

  return { toasts, notify, notifyError, dismiss, clear };
});
