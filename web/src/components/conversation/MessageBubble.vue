<template>
  <article class="message-bubble" :class="[`message-bubble--${role}`]" :data-role="role">
    <header v-if="author || timestamp" class="message-bubble__meta">
      <span v-if="author" class="message-bubble__author">{{ author }}</span>
      <time v-if="timestamp" class="message-bubble__time">{{ timestamp }}</time>
    </header>
    <div class="message-bubble__body"><slot /></div>
  </article>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  role?: 'user' | 'assistant' | 'system' | 'tool';
  author?: string;
  timestamp?: string;
}>(), { role: 'assistant' });
</script>

<style scoped>
.message-bubble { max-width: min(48rem, 100%); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-1); padding: 0.65rem 0.75rem; color: var(--text); }
.message-bubble--user { margin-left: auto; border-color: var(--entry-user-border); background: var(--entry-user-bg); }
.message-bubble--assistant { margin-right: auto; }
.message-bubble--system { border-color: var(--entry-warn-border); background: var(--entry-warn-bg); }
.message-bubble--tool { border-color: var(--entry-purple-border); background: var(--entry-purple-bg); }
.message-bubble__meta { display:flex; align-items:center; gap:0.5rem; margin-bottom:0.35rem; color:var(--text-muted); font-size:0.75rem; }
.message-bubble__author { font-weight:600; color:var(--text); }
.message-bubble__time { margin-left:auto; font-family:var(--mono); color:var(--text-faint); }
.message-bubble__body { line-height:1.5; overflow-wrap:anywhere; }
</style>
