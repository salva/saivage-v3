<template><footer v-if="calls.length" class="pending-call-footer"><span v-for="call in calls" :key="call.id">{{ call.tool }} pending</span></footer></template>
<script setup lang="ts">import type { PendingCall } from '../../api/types'; defineProps<{ calls: PendingCall[] }>();</script>
<style scoped>.pending-call-footer{display:flex;gap:6px;flex-wrap:wrap;color:var(--text-muted);font-size:12px;}.pending-call-footer span{border:1px solid var(--border);border-radius:999px;padding:2px 8px;}</style>
