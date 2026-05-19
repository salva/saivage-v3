<template>
  <section class="not-found-view" aria-labelledby="not-found-heading">
    <div class="not-found-card">
      <p class="eyebrow">Route not found</p>
      <h1 id="not-found-heading">404 — Not found</h1>
      <p class="not-found-copy">
        No operator surface is registered for
        <code>{{ requestedPath }}</code>.
      </p>
      <div class="not-found-actions">
        <RouterLink class="not-found-link" to="/dashboard">Back to Dashboard</RouterLink>
        <RouterLink class="not-found-link" to="/cards">Back to Cards</RouterLink>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const requestedPath = computed(() => route.fullPath);
</script>

<style scoped>
.not-found-view { min-height:100%; display:flex; align-items:center; justify-content:center; padding:32px; }
.not-found-card { max-width:560px; width:100%; background:#161b22; border:1px solid #30363d; border-radius:10px; padding:28px; color:#c9d1d9; }
.eyebrow { margin:0 0 8px; color:#8b949e; font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
h1 { margin:0 0 12px; color:#f0f6fc; font-size:24px; }
.not-found-copy { margin:0 0 20px; color:#8b949e; line-height:1.5; }
.not-found-copy code { color:#f0f6fc; background:#0d1117; border:1px solid #21262d; border-radius:4px; padding:2px 6px; word-break:break-all; }
.not-found-actions { display:flex; gap:10px; flex-wrap:wrap; }
.not-found-link { display:inline-flex; align-items:center; padding:8px 12px; border-radius:6px; border:1px solid #30363d; color:#58a6ff; text-decoration:none; background:#0d1117; }
.not-found-link:hover { border-color:#58a6ff; }
</style>
