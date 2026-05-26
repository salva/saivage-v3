<template><span class="ui-spinner" :aria-label="label" role="status" /></template>
<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: 'Loading' });
</script>
<style scoped>
.ui-spinner { display:inline-block; width:16px; height:16px; border:2px solid var(--border); border-top-color:var(--accent-2); border-radius:999px; animation:ui-spin 0.8s linear infinite; }
@keyframes ui-spin { to { transform:rotate(360deg); } }
</style>
