<template>
  <section class="sys-panel" data-testid="system-actions">
    <div class="sys-toolbar">
      <button type="button" class="sys-command" data-testid="actions-refresh" :disabled="actionsLoading" @click="refresh">Refresh</button>
      <span class="sys-note">Retained settled control actions with recorded actor, target, time, and result. Not a guaranteed audit of every action.</span>
    </div>
    <ViewState v-if="actionsLoading && !actions" state="loading" title="Reading settled control actions" />
    <ViewState v-else-if="actionsError" state="error" title="Control actions unavailable" :message="actionsError" />
    <ViewState v-else-if="actions && actions.control_actions.length === 0" state="empty" title="No settled control actions retained" message="Missing audit evidence proves neither that no action happened nor permission to repeat one." />
    <ol v-else-if="actions" class="actions-list" data-testid="actions-list">
      <li v-for="action in actions.control_actions" :key="action.id" class="actions-row" :data-result="action.outcome">
        <span class="actions-time" :title="action.created_at">{{ formatRecentTimestamp(action.created_at) }}</span>
        <span class="actions-summary">{{ action.actor }} · {{ action.action }}{{ action.target_id ? ` · ${action.target_kind}: ${action.target_id}` : '' }} — {{ action.params_summary }}</span>
        <span class="actions-result">{{ action.outcome }}: {{ action.outcome_summary }}</span>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useSystemResourcesStore } from '../../stores/systemResources';
import { formatRecentTimestamp } from '../../utils/timestamp';
import ViewState from '../ui/ViewState.vue';

const store = useSystemResourcesStore();
const { actions, actionsLoading, actionsError } = storeToRefs(store);

onMounted(() => { if (!actions.value && !actionsLoading.value) void store.fetchActions(); });
function refresh(): void { void store.fetchActions(); }
</script>

<style scoped>
.sys-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; }
.sys-toolbar { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sys-command { padding: 3px 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface-2); color: var(--text); font: inherit; font-size: 11px; cursor: pointer; }
.sys-command:disabled { opacity: 0.5; cursor: not-allowed; }
.sys-note { font-size: 11px; color: var(--text-muted); }
.actions-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.actions-row { display: flex; align-items: baseline; gap: 10px; font-size: 12px; padding: 4px 8px; background: var(--surface-1); border: 1px solid var(--surface-3); border-radius: 6px; }
.actions-time { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
.actions-summary { color: var(--text); min-width: 0; overflow-wrap: anywhere; }
.actions-result { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
.actions-row[data-result='ok'] .actions-result { color: var(--accent); }
.actions-row[data-result='error'] .actions-result { color: var(--danger); }
.actions-row[data-result='denied'] .actions-result { color: var(--warn); }
.sys-panel > :deep(.view-state) { padding: 12px 0; }
</style>
