<template>
  <footer class="pending-call-footer" role="status" aria-live="polite">
    <span v-if="calls.length === 0" class="thinking-pill"><span class="thinking-dot" aria-hidden="true"></span>{{ statusLabel }}</span>
    <template v-else>
      <span v-for="call in calls" :key="call.id" class="pending-pill"><span class="thinking-dot" aria-hidden="true"></span>{{ call.tool }} pending</span>
    </template>
  </footer>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { ActivityStatus, PendingCall } from '../../types/view-models';

const props = defineProps<{ calls: PendingCall[]; status?: ActivityStatus['status'] }>();
const statusLabel = computed(() => {
  switch (props.status) {
    case 'tool_calling': return 'Waiting for tool result...';
    case 'responding': return 'Writing response...';
    case 'compacting': return 'Compacting context...';
    case 'thinking':
    default: return 'Thinking...';
  }
});
</script>
<style scoped>
.pending-call-footer{display:flex;gap:6px;flex-wrap:wrap;color:var(--text-muted);font-size:12px;}
.pending-pill,.thinking-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:999px;padding:2px 8px;background:var(--surface-2);}
.thinking-dot{width:6px;height:6px;border-radius:999px;background:currentColor;animation:thinking-pulse 1s ease-in-out infinite;}
@keyframes thinking-pulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}
</style>
