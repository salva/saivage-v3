<template>
  <section class="sys-panel" data-testid="system-providers">
    <div class="sys-toolbar">
      <button type="button" class="sys-command" data-testid="providers-refresh" :disabled="providersLoading" @click="refresh">Refresh</button>
      <span class="sys-note">Process-local routing availability; it resets on restart and differs from any durable health history.</span>
    </div>
    <ViewState v-if="providersLoading && !providers" state="loading" title="Reading provider availability" />
    <ViewState v-else-if="providersError" state="error" title="Provider availability unavailable" :message="providersError" />
    <ViewState v-else-if="providers && Object.keys(providers.providers).length === 0" state="empty" title="No configured providers" />
    <div v-else-if="providers" class="sys-content-block">
      <p class="sys-note">Scope: {{ providers.availabilityScope }}. Expiry eligibility differs from recorded cooling; missing token/cost/usage metrics remain unknown.</p>
      <div v-for="(summary, name) in providers.providers" :key="name" class="provider-block">
        <h4 class="provider-name">{{ name }} <span class="provider-meta">priority {{ summary.priority }} · {{ summary.availableCandidateCount }}/{{ summary.candidateCount }} candidates available</span></h4>
        <ul class="provider-models">
          <li v-for="model in summary.models" :key="model">{{ model }}</li>
        </ul>
        <ul class="provider-availability">
          <li v-for="entry in summary.availability" :key="`${entry.candidate.provider}:${entry.candidate.account}:${entry.candidate.model}`" :data-state="entry.state">
            {{ entry.candidate.provider }}{{ entry.candidate.account ? `/${entry.candidate.account}` : '' }} · {{ entry.candidate.model }} — {{ entry.state }}{{ entry.state === 'HEALTHY' ? '' : ` until ${new Date(entry.untilMs).toISOString()}` }}{{ entry.reason ? ` (${entry.reason})` : '' }}
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useSystemResourcesStore } from '../../stores/systemResources';
import ViewState from '../ui/ViewState.vue';

const store = useSystemResourcesStore();
const { providers, providersLoading, providersError } = storeToRefs(store);

onMounted(() => { if (!providers.value && !providersLoading.value) void store.fetchProviders(); });
function refresh(): void { void store.fetchProviders(); }
</script>

<style scoped>
.sys-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; }
.sys-toolbar { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sys-command { padding: 3px 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface-2); color: var(--text); font: inherit; font-size: 11px; cursor: pointer; }
.sys-command:disabled { opacity: 0.5; cursor: not-allowed; }
.sys-note { font-size: 11px; color: var(--text-muted); }
.provider-block { border: 1px solid var(--surface-3); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
.provider-name { margin: 0 0 6px; font-size: 13px; color: var(--text); }
.provider-meta { font-size: 11px; color: var(--text-muted); font-weight: 400; margin-left: 8px; }
.provider-models { list-style: none; margin: 0 0 6px; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.provider-models li { font-family: var(--font-mono); font-size: 10px; background: var(--surface-3); border-radius: 4px; padding: 1px 6px; color: var(--text); }
.provider-availability { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.provider-availability li { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }
.provider-availability li[data-state='HEALTHY'] { color: var(--accent); }
.provider-availability li[data-state='BLOCKED_UNTIL'], .provider-availability li[data-state='COOLING'] { color: var(--warn); }
.sys-panel > :deep(.view-state) { padding: 12px 0; }
</style>
