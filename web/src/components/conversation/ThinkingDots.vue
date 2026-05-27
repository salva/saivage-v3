<template>
  <span class="thinking-dots" role="status" :aria-label="label">
    <span class="thinking-dots__dot"></span>
    <span class="thinking-dots__dot"></span>
    <span class="thinking-dots__dot"></span>
  </span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: 'Thinking' });
</script>

<style scoped>
.thinking-dots { display:inline-flex; align-items:center; gap:0.25rem; color:var(--text-muted); }
.thinking-dots__dot { width:0.35rem; height:0.35rem; border-radius:999px; background:currentColor; animation:thinking-dot 1s ease-in-out infinite; }
.thinking-dots__dot:nth-child(2) { animation-delay:0.12s; }
.thinking-dots__dot:nth-child(3) { animation-delay:0.24s; }
@keyframes thinking-dot { 0%, 80%, 100% { opacity:0.35; transform:translateY(0); } 40% { opacity:1; transform:translateY(-0.15rem); } }
</style>
