<template>
  <footer class="pending-call-footer" role="status" aria-live="polite">
    <span v-if="status === 'active'" class="activity-pill"><span class="activity-dot" aria-hidden="true"></span>Active</span>
    <template v-else>
      <span v-for="call in calls" :key="call.id" class="pending-pill"><span class="activity-dot" aria-hidden="true"></span>Waiting for {{ call.tool }}</span>
    </template>
  </footer>
</template>
<script setup lang="ts">
import type { ActivityStatus, PendingCall } from '../../types/view-models';

const props = defineProps<{ calls: PendingCall[]; status?: ActivityStatus['status'] }>();
</script>
<style scoped>
.pending-call-footer{display:flex;gap:6px;flex-wrap:wrap;color:var(--text-muted);font-size:12px;}
.pending-pill,.activity-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:999px;padding:2px 8px;background:var(--surface-2);}
.activity-dot{width:6px;height:6px;border-radius:999px;background:currentColor;animation:activity-pulse 1s ease-in-out infinite;}
@keyframes activity-pulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}
</style>
