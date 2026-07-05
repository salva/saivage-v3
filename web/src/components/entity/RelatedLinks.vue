<template>
  <nav v-if="links.length" class="related-links" :aria-label="label">
    <span class="related-links__label">{{ label }}</span>
    <div class="related-links__items">
      <EntityLink
        v-for="link in links"
        :key="`${link.kind}:${link.id}:${link.label ?? ''}`"
        :kind="link.kind"
        :id="link.id"
        :label="link.label"
        :title="link.title"
        :missing="link.missing"
      />
    </div>
  </nav>
</template>

<script setup lang="ts">
import EntityLink from './EntityLink.vue';

defineProps<{
  label: string;
  links: Array<{
    kind: 'card' | 'agent' | 'file' | 'process';
    id: string;
    label?: string | null;
    title?: string | null;
    missing?: boolean;
  }>;
}>();
</script>

<style scoped>
.related-links { display:flex; align-items:flex-start; gap:10px; padding:10px 12px; border:1px solid var(--surface-3); border-radius:6px; background:var(--surface-1); flex-wrap:wrap; }
.related-links__label { font-size:11px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.04em; padding-top:7px; }
.related-links__items { display:flex; flex-wrap:wrap; gap:8px; min-width:0; }
</style>
