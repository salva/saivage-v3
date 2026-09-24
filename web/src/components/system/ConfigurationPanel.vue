<template>
  <section class="sys-panel" data-testid="system-configuration">
    <div class="sys-toolbar">
      <button type="button" class="sys-command" data-testid="config-refresh" :disabled="configLoading" @click="refresh">Refresh</button>
      <span class="sys-note">Saved effective configuration, read-only. Installed workflow/model/tool bindings are a separate fact (Installed workflows section).</span>
    </div>
    <ViewState v-if="configLoading && !config" state="loading" title="Reading saved configuration" />
    <ViewState v-else-if="configError" state="error" title="Configuration unavailable" :message="configError" />
    <template v-else-if="config">
      <StatusBanner v-for="warning in config.warnings" :key="warning" tone="warning" :message="warning" />
      <details class="config-json" open>
        <summary>Effective configuration (safe projection)</summary>
        <CodeBlock :code="formatJson(config.config)" language="json" copyable />
      </details>
      <p class="sys-note">A saved configuration change takes effect at next start; it must not be mistaken for current execution bindings. No editor, prompt-body viewer, or hot reload is offered.</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useSystemResourcesStore } from '../../stores/systemResources';
import { formatJson } from '../../utils/format-json';
import CodeBlock from '../content/CodeBlock.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';

const store = useSystemResourcesStore();
const { config, configLoading, configError } = storeToRefs(store);

onMounted(() => { if (!config.value && !configLoading.value) void store.fetchConfig(); });
function refresh(): void { void store.fetchConfig(); }
</script>

<style scoped>
.sys-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; }
.sys-toolbar { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sys-command { padding: 3px 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface-2); color: var(--text); font: inherit; font-size: 11px; cursor: pointer; }
.sys-command:disabled { opacity: 0.5; cursor: not-allowed; }
.sys-note { font-size: 11px; color: var(--text-muted); }
.config-json > summary { cursor: pointer; font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
.sys-panel > :deep(.view-state) { padding: 12px 0; }
.sys-panel > :deep(.status-banner) { margin: 0; }
</style>
