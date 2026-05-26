<template><span class="ui-status-dot" :class="`ui-status-dot--${tone}`" :aria-label="label" /></template>
<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent'; label?: string }>(), { tone: 'neutral', label: undefined });
</script>
<style scoped>
.ui-status-dot { display:inline-block; width:8px; height:8px; border-radius:999px; background:var(--text-muted); }
.ui-status-dot--success { background:var(--accent); }
.ui-status-dot--warning { background:var(--warn); }
.ui-status-dot--danger { background:var(--danger); }
.ui-status-dot--accent { background:var(--accent-2); }
</style>
