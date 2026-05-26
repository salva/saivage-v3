<template>
  <Overlay :visible="visible" @dismiss="closeDialog">
    <Card class="token-dialog">
      <h2 class="token-title">API Token</h2>
      <p class="token-description">
        Enter an API token to access a secured Saivage deployment.
        The token is stored in <code class="inline-token">localStorage</code> and sent with every API request.
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
            placeholder="64-char hex token"
            autocomplete="off"
            spellcheck="false"
          />
          <Button
            type="button"
            class="token-toggle"
            size="icon"
            @click="showToken = !showToken"
            :title="showToken ? 'Hide token' : 'Show token'"
          >
            {{ showToken ? '🙈' : '👁' }}
          </Button>
        </div>

        <div class="token-actions">
          <Button type="submit" class="token-btn-save" variant="primary" :disabled="!token.trim()">
            Save
          </Button>
          <Button
            type="button"
            class="token-btn-clear"
            variant="danger"
            @click="clearToken"
            :disabled="!savedToken"
          >
            Clear
          </Button>
          <Button type="button" class="token-btn-cancel" @click="closeDialog">
            Cancel
          </Button>
        </div>
      </form>

      <p v-if="savedToken" class="token-status">
        Token is set.
      </p>
      <p v-else class="token-status token-status-none">
        No token configured.
      </p>
    </Card>
  </Overlay>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from 'vue';
import { getAuthToken, setAuthToken, clearAuthToken } from '../../api/auth';
import Button from '../ui/Button.vue';
import Card from '../ui/Card.vue';
import Overlay from '../ui/Overlay.vue';

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
.token-dialog {
  width: 420px;
  max-width: 90vw;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.token-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}

.token-description {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.5;
  margin-bottom: 16px;
}

.token-description code {
  background: var(--surface-3);
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
  color: var(--text);
}

.token-input-row {
  display: flex;
  gap: 4px;
}

.token-input {
  flex: 1;
  padding: 8px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 13px;
  font-family: ui-monospace, 'SF Mono', monospace;
  outline: none;
  transition: border-color 0.15s;
}

.token-input:focus {
  border-color: var(--accent-2);
}

.token-toggle {
  flex-shrink: 0;
  font-size: 16px;
  line-height: 1;
}

.token-actions {
  display: flex;
  gap: 8px;
}

.token-btn-cancel {
  margin-left: auto;
}

.token-status {
  margin-top: 12px;
  font-size: 12px;
  color: var(--accent);
}

.token-status-none {
  color: var(--text-muted);
}
</style>
