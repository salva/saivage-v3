<template>
  <span class="ui-pill" :class="[`ui-pill--${tone}`]"><slot /></span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }>(), { tone: 'neutral' });
</script>

<style scoped>
.ui-pill { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--border); border-radius:999px; padding:2px 8px; font-size:11px; line-height:1.4; color:var(--text-muted); background:var(--surface-2); }
.ui-pill--accent { color:var(--accent-2); border-color:var(--accent-2); background:var(--entry-user-bg); }
.ui-pill--success { color:var(--accent); }
.ui-pill--warning { color:var(--warn); background:var(--entry-warn-bg); border-color:var(--entry-warn-border); }
.ui-pill--danger { color:var(--danger); background:var(--entry-danger-bg); border-color:var(--entry-danger-border); }
</style>
