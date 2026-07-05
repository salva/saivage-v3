import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { clearAuthToken, getAuthToken, setAuthToken } from '../api/auth';

export const AUTH_TOKEN_CHANGED_EVENT = 'saivage:auth-token-changed';

function emitTokenChanged(): void {
  window.dispatchEvent(new CustomEvent(AUTH_TOKEN_CHANGED_EVENT));
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(getAuthToken());
  const hasToken = computed(() => Boolean(token.value));

  function refresh(): void {
    token.value = getAuthToken();
  }

  function saveToken(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    setAuthToken(trimmed);
    refresh();
    emitTokenChanged();
  }

  function clearToken(): void {
    clearAuthToken();
    refresh();
    emitTokenChanged();
  }

  return { token, hasToken, refresh, saveToken, clearToken };
});
