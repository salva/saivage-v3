<template>
  <section class="debug-section">
    <div class="debug-section-header operator-header">
      <div>
        <h4 class="debug-section-title">Pending confirmations</h4>
        <p class="operator-subtitle">Out-of-chat confirmation is read-only here. These preview-only audit entries still require confirmation through the originating chat or control surface.</p>
      </div>
      <div class="operator-actions-inline">
        <button class="sv-fetch-btn" :disabled="controlActionsLoading" @click="debugStore.fetchControlActions()">Refresh</button>
      </div>
    </div>

    <div v-if="controlActionsLoading && controlActionsState === 'idle'" class="debug-loading">Loading pending confirmations…</div>
    <div v-else-if="controlActionsState === 'unauthorized'" class="operator-banner operator-banner-error" role="alert">{{ controlActionsError }}</div>
    <div v-else-if="controlActionsState === 'error'" class="operator-banner operator-banner-error" role="alert">{{ controlActionsError }}</div>
    <div v-else-if="pendingConfirmations.length === 0" class="debug-empty">No preview-only control actions are awaiting follow-up.</div>
    <div v-else class="notifications-list">
      <article v-for="entry in pendingConfirmations" :key="entry.id" class="notification-card">
        <div class="notification-header">
          <span class="notification-kind">{{ entry.action }}</span>
          <span class="notification-severity severity-warn">preview_only</span>
          <span class="operator-note-time">{{ fmtDate(entry.created_at) }}</span>
        </div>
        <div class="notification-body">{{ entry.outcome_summary }}</div>
        <div class="operator-note-meta">
          <span v-if="entry.target_kind" class="mono">{{ entry.target_kind }}</span>
          <span v-if="entry.target_id" class="mono">{{ entry.target_id }}</span>
          <span class="mono">{{ entry.surface }}</span>
          <span class="mono">{{ entry.actor }}</span>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useDebugStore } from '../../stores/debug';

const debugStore = useDebugStore();
const { pendingConfirmations, controlActionsLoading, controlActionsError, controlActionsState } = storeToRefs(debugStore);

function fmtDate(ts: string): string {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

onMounted(() => {
  if (debugStore.controlActionsState === 'idle') {
    void debugStore.fetchControlActions().catch(() => {});
  }
});
</script>

<style scoped>
.notifications-list { display:flex; flex-direction:column; gap:10px; }
.notification-card { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:12px; }
.notification-header { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px; }
.notification-kind,.notification-severity { font-size:10px; font-weight:600; text-transform:uppercase; border-radius:999px; padding:2px 8px; }
.notification-kind { background:#1c2738; color:#58a6ff; }
.notification-severity.severity-warn { background:#241f18; color:#e3b341; }
.notification-body { font-size:13px; color:#c9d1d9; white-space:pre-wrap; word-break:break-word; margin-bottom:8px; }
</style>
