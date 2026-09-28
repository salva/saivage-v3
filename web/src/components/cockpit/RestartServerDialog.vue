<template>
  <Dialog :visible="visible" title-id="restart-server-dialog-title" @dismiss="cancel">
    <div class="restart-dialog">
      <h2 id="restart-server-dialog-title" class="restart-title">Restart server</h2>
      <p class="restart-explanation">
        This shuts down the whole Saivage server process after in-flight work is terminal-coordinated.
        To halt project work without shutting down the server, ask the Analyst to stop the project.
      </p>
      <p class="restart-explanation">
        Acceptance means the shutdown is scheduled. It does not promise that a replacement server is
        already running; re-observe after the restart settles.
      </p>
      <label class="restart-confirm-label" for="restart-server-confirmation">
        Type <code>RESTART SERVER</code> exactly to confirm
      </label>
      <input
        id="restart-server-confirmation"
        v-model="confirmationText"
        class="restart-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        data-testid="restart-confirmation-input"
        :disabled="sending"
        @keydown.enter="confirm"
      />
      <StatusBanner v-if="error" tone="danger" :message="error" data-testid="restart-confirmation-error" />
      <div class="restart-actions">
        <button type="button" class="restart-cancel" data-testid="restart-confirmation-cancel" :disabled="sending" @click="cancel">Cancel</button>
        <button
          type="button"
          class="restart-submit"
          data-testid="restart-confirmation-submit"
          :disabled="!confirmationExact || sending"
          @click="confirm"
        >Restart server</button>
      </div>
    </div>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from '../ui/Dialog.vue';
import StatusBanner from '../ui/StatusBanner.vue';

const props = defineProps<{ visible: boolean; sending: boolean; error: string | null }>();
const emit = defineEmits<{ close: []; confirmed: [] }>();

const confirmationText = ref('');
const confirmationExact = computed(() => confirmationText.value === 'RESTART SERVER');

watch(() => props.visible, (visible) => {
  if (visible) confirmationText.value = '';
});

function cancel(): void {
  if (props.sending) return;
  emit('close');
}

function confirm(): void {
  if (!confirmationExact.value || props.sending) return;
  emit('confirmed');
}
</script>

<style scoped>
.restart-dialog { min-width: 380px; max-width: 480px; padding: 18px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; }
.restart-title { margin: 0 0 10px; font-size: 15px; font-weight: 700; color: var(--text); }
.restart-explanation { margin: 0 0 10px; font-size: 12px; line-height: 1.5; color: var(--text-muted); }
.restart-confirm-label { display: block; margin: 12px 0 6px; font-size: 12px; color: var(--text); }
.restart-input {
  width: 100%; box-sizing: border-box; padding: 8px 10px;
  border: 1px solid var(--border-strong); border-radius: 6px;
  background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px;
}
.restart-input:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 1px; }
.restart-dialog > :deep(.status-banner) { margin: 10px 0 0; }
.restart-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.restart-cancel, .restart-submit {
  padding: 6px 14px; border-radius: 6px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.restart-cancel { border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text); }
.restart-submit { border: 1px solid var(--danger); background: var(--surface-2); color: var(--danger); }
.restart-submit:disabled, .restart-cancel:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
