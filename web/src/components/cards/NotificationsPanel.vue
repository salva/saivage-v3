<template>
  <section class="debug-section">
    <div class="debug-section-header operator-header">
      <div>
        <h4 class="debug-section-title">Notifications Inbox ({{ notificationsTotal }})</h4>
        <p class="operator-subtitle">Pending operator-surface notifications refresh from WebSocket activity and can be acknowledged here.</p>
      </div>
      <div class="operator-actions-inline">
        <button class="sv-fetch-btn" :disabled="notificationsLoading" @click="debugStore.fetchNotifications()">Refresh</button>
      </div>
    </div>

    <div v-if="notificationsLoading && notificationsState === 'idle'" class="debug-loading">Loading notifications…</div>
    <div v-else-if="notificationsState === 'unauthorized'" class="operator-banner operator-banner-error" role="alert">{{ notificationsError }}</div>
    <div v-else-if="notificationsState === 'error'" class="operator-banner operator-banner-error" role="alert">{{ notificationsError }}</div>
    <div v-else-if="notificationsState === 'empty'" class="debug-empty">No pending operator notifications.</div>
    <div v-else class="notifications-list">
      <article v-for="notification in notifications" :key="notification.id" class="notification-card">
        <div class="notification-header">
          <span class="notification-kind">{{ notification.kind }}</span>
          <span class="notification-severity" :class="`severity-${notification.severity}`">{{ notification.severity }}</span>
          <span class="operator-note-time">{{ fmtDate(notification.created_at) }}</span>
        </div>
        <div class="notification-body">{{ notification.payload_summary }}</div>
        <div class="operator-note-meta">
          <span v-if="notification.related_card_id" class="mono">Card {{ notification.related_card_id }}</span>
          <span v-if="notification.related_note_id" class="mono">Note {{ notification.related_note_id }}</span>
          <span v-if="notification.related_process_id" class="mono">Process {{ notification.related_process_id }}</span>
          <span v-if="notification.related_version_seq" class="mono">v{{ notification.related_version_seq }}</span>
        </div>
        <div class="operator-note-actions">
          <button
            class="operator-button"
            :disabled="Boolean(notificationActionLoading[notification.id])"
            :aria-label="`Acknowledge notification ${notification.id}`"
            @click="debugStore.acknowledgeOperatorNotification(notification.id)"
          >{{ notificationActionLoading[notification.id] ? 'Acknowledging…' : 'Acknowledge' }}</button>
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
const { notifications, notificationsTotal, notificationsLoading, notificationsError, notificationsState, notificationActionLoading } = storeToRefs(debugStore);

function fmtDate(ts: string): string {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

onMounted(() => {
  if (debugStore.notificationsState === 'idle') {
    void debugStore.fetchNotifications().catch(() => {});
  }
});
</script>

<style scoped>
.notifications-list { display:flex; flex-direction:column; gap:10px; }
.notification-card { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:12px; }
.notification-header { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px; }
.notification-kind,.notification-severity { font-size:10px; font-weight:600; text-transform:uppercase; border-radius:999px; padding:2px 8px; }
.notification-kind { background:#1c2738; color:#58a6ff; }
.notification-severity { background:#21262d; color:#c9d1d9; }
.notification-severity.severity-info { background:#1c2738; color:#58a6ff; }
.notification-severity.severity-warn { background:#241f18; color:#e3b341; }
.notification-severity.severity-block { background:#241818; color:#ff938a; }
.notification-body { font-size:13px; color:#c9d1d9; white-space:pre-wrap; word-break:break-word; margin-bottom:8px; }
</style>
