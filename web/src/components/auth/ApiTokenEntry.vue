<template>
  <Transition name="modal">
    <div v-if="visible" class="token-overlay" @click.self="closeDialog">
      <div class="token-dialog">
        <h2 class="token-title">API Token</h2>
        <p class="token-description">
          Enter an API token to access a secured Saivage deployment.
          The token is stored in <code>localStorage</code> and sent with every API request.
        </p>

        <form @submit.prevent="saveToken" class="token-form">
          <label class="token-label" for="api-token-input">Token</label>
          <div class="token-input-row">
            <input
              id="api-token-input"
              ref="inputRef"
              v-model="token"
              :type="showToken ? 'text' : 'password'"
              class="token-input"
              placeholder="saivage_..."
              autocomplete="off"
              spellcheck="false"
            />
            <button
              type="button"
              class="token-toggle"
              @click="showToken = !showToken"
              :title="showToken ? 'Hide token' : 'Show token'"
            >
              {{ showToken ? '🙈' : '👁' }}
            </button>
          </div>

          <div class="token-actions">
            <button type="submit" class="token-btn token-btn-save" :disabled="!token.trim()">
              Save
            </button>
            <button
              type="button"
              class="token-btn token-btn-clear"
              @click="clearToken"
              :disabled="!savedToken"
            >
              Clear
            </button>
            <button type="button" class="token-btn token-btn-cancel" @click="closeDialog">
              Cancel
            </button>
          </div>
        </form>

        <p v-if="savedToken" class="token-status">
          Token is set ({{ savedToken.substring(0, 12) }}...).
        </p>
        <p v-else class="token-status token-status-none">
          No token configured.
        </p>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from 'vue';
import { getAuthToken, setAuthToken, clearAuthToken } from '../../api/auth';

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  close: [];
  saved: [];
}>();

const token = ref('');
const showToken = ref(false);
const savedToken = ref<string | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
let escapeListenerRegistered = false;

watch(
  () => props.visible,
  async (v) => {
    if (v) {
      addEscapeListener();
      await nextTick();
      inputRef.value?.focus();
      savedToken.value = getAuthToken();
    } else {
      removeEscapeListener();
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  removeEscapeListener();
});

function addEscapeListener(): void {
  if (escapeListenerRegistered) return;
  window.addEventListener('keydown', handleEscapeKeydown);
  escapeListenerRegistered = true;
}

function removeEscapeListener(): void {
  if (!escapeListenerRegistered) return;
  window.removeEventListener('keydown', handleEscapeKeydown);
  escapeListenerRegistered = false;
}

function handleEscapeKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.visible) return;
  closeDialog();
}

function closeDialog(): void {
  emit('close');
}

function saveToken(): void {
  const trimmed = token.value.trim();
  if (!trimmed) return;
  setAuthToken(trimmed);
  savedToken.value = trimmed;
  token.value = '';
  emit('saved');
}

function clearToken(): void {
  clearAuthToken();
  savedToken.value = null;
  token.value = '';
  showToken.value = false;
}
</script>

<style scoped>
.token-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.token-dialog {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 24px;
  width: 420px;
  max-width: 90vw;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.token-title {
  font-size: 16px;
  font-weight: 600;
  color: #f0f6fc;
  margin-bottom: 8px;
}

.token-description {
  font-size: 13px;
  color: #8b949e;
  line-height: 1.5;
  margin-bottom: 16px;
}

.token-description code {
  background: #21262d;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}

.token-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.token-label {
  font-size: 12px;
  font-weight: 600;
  color: #c9d1d9;
}

.token-input-row {
  display: flex;
  gap: 4px;
}

.token-input {
  flex: 1;
  padding: 8px 12px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  color: #c9d1d9;
  font-size: 13px;
  font-family: ui-monospace, 'SF Mono', monospace;
  outline: none;
  transition: border-color 0.15s;
}

.token-input:focus {
  border-color: #58a6ff;
}

.token-toggle {
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  flex-shrink: 0;
}

.token-actions {
  display: flex;
  gap: 8px;
}

.token-btn {
  padding: 6px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid #30363d;
  font-family: inherit;
  transition: background-color 0.15s;
}

.token-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.token-btn-save {
  background: #238636;
  color: #fff;
  border-color: #238636;
}
.token-btn-save:hover:not(:disabled) {
  background: #2ea043;
}

.token-btn-clear {
  background: #21262d;
  color: #f85149;
}
.token-btn-clear:hover:not(:disabled) {
  background: #30363d;
}

.token-btn-cancel {
  background: #21262d;
  color: #c9d1d9;
  margin-left: auto;
}
.token-btn-cancel:hover {
  background: #30363d;
}

.token-status {
  margin-top: 12px;
  font-size: 12px;
  color: #3fb950;
}

.token-status-none {
  color: #8b949e;
}

/* Transition */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}
.modal-enter-active .token-dialog,
.modal-leave-active .token-dialog {
  transition: transform 0.2s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .token-dialog {
  transform: scale(0.95);
}
.modal-leave-to .token-dialog {
  transform: scale(0.95);
}
</style>
