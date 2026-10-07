<template>
  <section v-if="section.content !== undefined || section.fields?.length || section.items" class="semantic-section">
    <h4>{{ section.title }}</h4>
    <dl v-if="section.fields?.length">
      <div v-for="(field, index) in section.fields" :key="index"><dt>{{ field.label }}</dt><dd><InlineParts :parts="field.parts" /></dd></div>
    </dl>
    <details v-if="section.content !== undefined && section.disclosure"><summary>Show {{ section.title }}</summary><CodeBlock :code="section.content" :language="section.language" copyable wrap /></details>
    <CodeBlock v-else-if="section.content !== undefined" :code="section.content" :language="section.language" copyable wrap />
    <ToolSemanticSection v-for="(item, index) in section.items" :key="index" :section="item" />
  </section>
</template>
<script setup lang="ts">
import type { SemanticSection } from '../../utils/tool-presenters/types';
import InlineParts from '../content/InlineParts.vue';
import CodeBlock from '../content/CodeBlock.vue';
defineProps<{ section: SemanticSection }>();
</script>
<style scoped>
.semantic-section { min-width:0; max-width:100%; overflow-wrap:anywhere; }
h4 { margin:8px 0; font-size:12px; }
dl { margin:0; }
dl > div { display:flex; flex-wrap:wrap; gap:8px; padding:2px 0; }
dt { color:var(--text-muted); }
dd { margin:0; min-width:0; max-width:100%; }
dd :deep(.inline-parts) { flex-wrap:wrap; }
summary { cursor:pointer; font-size:12px; }
</style>
