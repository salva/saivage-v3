<template>
  <div class="dashboard-layout" data-testid="route-dashboard">
    <Panel as="section" :padded="false" scroll class="runtime-console" aria-label="Runtime Console">
      <div class="console-header">
        <PanelHeader title="Runtime Console">
          <template #actions>
            <button class="runtime-command" :disabled="!canStopProject" @click="stopProject">Stop project</button>
            <button v-if="restartServerAvailable" class="runtime-command danger" @click="restartServer">Restart server</button>
            <button
              class="ui-refresh-button"
              :disabled="runtimeLoading"
              @click="refreshRuntime"
              :title="runtimeLoading ? 'Refreshing — please wait' : 'Refresh runtime state'"
              :aria-label="runtimeLoading ? 'Refreshing — please wait' : 'Refresh runtime state'"
            >↻</button>
          </template>
        </PanelHeader>
      </div>

      <div class="console-body">
        <StatusBanner v-if="runtimeBannerMessage" :tone="runtimeBannerTone" :message="runtimeBannerMessage" />
        <StatusBanner v-if="commandError" tone="danger" :message="commandError" />
        <StatusBanner v-if="loaded && refreshError" tone="warning" :message="refreshError" />
        <StatusBanner
          v-if="contentPolicyError"
          tone="warning"
          message="Content-policy refusal status is unavailable."
          data-testid="content-policy-unavailable"
        />
        <div v-else-if="contentPolicyValue && contentPolicyValue.refusal_high_water > 0" class="content-policy-banner" data-testid="content-policy-banner">
          <strong>{{ contentPolicyValue.refusal_high_water }} provider content-policy refusal{{ contentPolicyValue.refusal_high_water === 1 ? '' : 's' }}</strong>
          <span v-if="contentPolicyValue.latest">
            Latest: {{ contentPolicyValue.latest.card_id }} at {{ shortTime(contentPolicyValue.latest.blocked_at) }}.
            <RouterLink :to="contentPolicyValue.latest.evidence_url">Open exact Agent entry</RouterLink>
          </span>
        </div>
        <ViewState v-if="!loaded && runtimeLoading" state="loading" title="Loading runtime state" />
        <ViewState v-else-if="!loaded && runtimeError" state="error" title="Failed to load runtime" :message="runtimeError" />

        <template v-else>
          <section v-if="currentCardId" class="status-section">
            <div class="mission-active">
              <span class="status-key">Active card</span>
              <button class="mission-active-link" @click="goToCard(currentCardId)">
                <span class="mission-active-title">{{ activeCardTitle }}</span>
              </button>
            </div>
          </section>

          <section class="status-section">
            <h3 class="section-label">Runtime Status</h3>
            <div class="status-grid">
              <div class="status-item">
                <span class="status-key">Status</span>
                <span class="status-value">{{ statusLabel }}</span>
              </div>
              <div class="status-item">
                <span class="status-key">WebSocket</span>
                <span class="status-value">{{ socketLabel }}</span>
              </div>
            </div>
            <p class="operator-help">{{ runtimeDetail }}</p>
            <p class="operator-help">{{ socketDetail }}</p>
          </section>

          <section class="status-section">
            <h3 class="section-label">Runtime REST Snapshot</h3>
            <div class="status-grid">
              <div class="status-item">
                <span class="status-key">REST request</span>
                <span class="status-value">{{ restRequestLabel }}</span>
              </div>
              <div class="status-item">
                <span class="status-key">Last successful refresh</span>
                <span class="status-value" :title="shortTimeTitle(lastFetchedAt)">{{ absoluteTime(lastFetchedAt) }}</span>
              </div>
            </div>
          </section>

          <section class="status-section child-of-goal-panel" data-testid="dashboard-child-of-goal-panel">
            <h3 class="section-label">Displayed Card Children</h3>
            <ul data-testid="child-of-goal-list" class="child-of-goal-list">
              <li v-for="child in goalChildren" :key="child.id" data-testid="child-of-goal-item" class="child-of-goal-item">
                <span class="title">{{ child.title }}</span>
                 <StatusBadge :status="statusForCard(child.status)" />
              </li>
            </ul>
            <div v-if="goalChildren.length === 0" class="status-value dim list-empty">none</div>
          </section>

        </template>
      </div>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { useRuntimeStore } from '../stores/runtime';
import { useCardStore } from '../stores/cards';
import { useContentPolicyStore } from '../stores/contentPolicy';
import { useSyncStore } from '../stores/sync';
import { selectSocketDetail, selectSocketLabel } from '../stores/runtime-read-model';
import { useDashboardReadModel } from '../composables/useDashboardReadModel';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../utils/timestamp';
import { statusForCard, type Tone } from '../utils/status';
import Panel from '../components/ui/Panel.vue';
import PanelHeader from '../components/ui/PanelHeader.vue';
import StatusBanner from '../components/ui/StatusBanner.vue';
import StatusBadge from '../components/ui/StatusBadge.vue';
import ViewState from '../components/ui/ViewState.vue';

const runtimeStore = useRuntimeStore();
const cardsStore = useCardStore();
const contentPolicyStore = useContentPolicyStore();
const syncStore = useSyncStore();
const router = useRouter();
const { value: contentPolicyValue, error: contentPolicyError } = storeToRefs(contentPolicyStore);

const {
  runtime,
  loaded,
  loading: runtimeLoading,
  refreshing: runtimeRefreshing,
  error: runtimeError,
  refreshError,
  statusLabel,
  runtimeDetail,
  currentCardId,
  unauthorized: runtimeUnauthorized,
  lastFetchedAt,
  restartServerAvailable,
  status,
} = storeToRefs(runtimeStore);
const { connectionState } = storeToRefs(syncStore);
const socketLabel = computed(() => selectSocketLabel(connectionState.value ?? 'offline'));
const socketDetail = computed(() => selectSocketDetail(connectionState.value ?? 'offline'));

const commandError = ref<string | null>(null);
const canStopProject = computed(() => ['starting', 'running', 'pausing', 'paused', 'error'].includes(status.value ?? ''));
const restRequestLabel = computed(() => {
  if (!loaded.value && runtimeLoading.value) return 'Loading';
  if (loaded.value && runtimeRefreshing.value) return 'Refreshing';
  if (loaded.value && refreshError.value) return 'Refresh failed';
  if (loaded.value) return 'Loaded';
  return 'Not loaded';
});

async function stopProject(): Promise<void> {
  commandError.value = null;
  try { await runtimeStore.stopProject(); } catch (error) { commandError.value = error instanceof Error ? error.message : String(error); }
}
async function restartServer(): Promise<void> {
  if (window.prompt('Type RESTART SERVER to confirm server restart:') !== 'RESTART SERVER') return;
  commandError.value = null;
  try { await runtimeStore.restartServer(); } catch (error) { commandError.value = error instanceof Error ? error.message : String(error); }
}

const { goalChildren, runtimeBannerMessage, runtimeBannerClass } = useDashboardReadModel({
  runtimeRefs: {
    statusLabel,
    unauthorized: runtimeUnauthorized,
    currentCardId,
  },
  cardsStore,
});

const runtimeBannerTone = computed<Tone>(() => runtimeBannerClass.value === 'runtime-status-banner-error' ? 'danger' : 'warning');
const activeCardTitle = computed(() => {
  const id = currentCardId.value;
  if (!id) return id ?? 'none';
  const card = cardsStore.hierarchyCardById(id);
  return card?.title ?? id;
});

function shortTime(ts?: string | null): string {
  if (!ts) return 'unknown';
  return formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute');
}
function shortTimeTitle(ts?: string | null): string {
  return ts ? timestampTitle(ts) : '';
}
function absoluteTime(ts?: string | null): string {
  return ts ? formatTimestamp(ts, 'absolute') : 'Never';
}

function goToCard(id: string): void {
  router.push({ name: 'card-detail', params: { id } });
}

async function refreshRuntime(): Promise<void> {
  await runtimeStore.fetchState().catch(() => {});
}

</script>

<style scoped>
.dashboard-layout { display: flex; height: 100%; gap: 0; }
.runtime-console { width: 100%; min-width: 0; flex: 1; background: var(--bg); }
.console-header { padding: 12px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.console-header :deep(.ui-panel-header) { margin-bottom: 0; }
.console-body { padding: 4px 0; }
.console-body :deep(.status-banner) { margin: 8px 16px; }
.content-policy-banner { margin:8px 16px; padding:10px 12px; display:flex; flex-direction:column; gap:4px; border:1px solid var(--warn); border-radius:6px; background:var(--entry-warn-bg); color:var(--text); font-size:12px; }
.content-policy-banner a { color:var(--accent-2); }
.console-body :deep(.view-state) { padding: 16px; }
.ui-refresh-button { background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-muted); cursor: pointer; width: 28px; height: 28px; font-size: 14px; display: flex; align-items: center; justify-content: center; transition: color 0.15s, border-color 0.15s; }
.ui-refresh-button:hover:not(:disabled) { color: var(--accent-2); border-color: var(--accent-2); }
.ui-refresh-button:disabled { opacity: 0.5; cursor: not-allowed; }
.status-section { padding: 12px 16px; border-bottom: 1px solid var(--surface-3); }
.mission-active { display: flex; align-items: baseline; gap: var(--space-6); }
.mission-active-link { background: none; border: none; cursor: pointer; display: inline-flex; align-items: baseline; gap: var(--space-4); font: inherit; padding: 0; color: var(--accent-2); text-decoration: underline; text-decoration-color: transparent; transition: text-decoration-color 0.15s; }
.mission-active-link:hover { text-decoration-color: var(--accent-2); }
.mission-active-title { font-size: var(--font-size-lg); font-weight: 600; color: var(--accent-2); }
.mission-active-phase { font-size: var(--font-size-sm); color: var(--text-muted); text-transform: capitalize; }
.mission-stats { display: flex; gap: var(--space-8); flex-wrap: wrap; }
.mission-stat { font-size: var(--font-size-md); color: var(--text-muted); display: inline-flex; align-items: baseline; gap: var(--space-2); }
.mission-stat strong { font-size: var(--font-size-xl); font-weight: 700; color: var(--text); }
.mission-stat.success strong { color: var(--accent); }
.mission-stat.danger strong { color: var(--danger); }
.section-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 8px 0; display: flex; align-items: center; gap: 6px; }
.section-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--surface-3); color: var(--text); font-size: 10px; font-weight: 600; }
.status-grid { display: grid; grid-template-columns: 1fr auto; gap: 6px; }
.status-item { display: contents; }
.status-key { font-size: 12px; color: var(--text-muted); padding: 2px 0; }
.status-value { font-size: 12px; color: var(--text); text-align: right; font-family: 'SF Mono', monospace; }
.status-value.dim { color: var(--border-strong); }
.status-value.success { color: var(--accent); }
.status-value.danger { color: var(--danger); }
.status-value.clickable { color: var(--accent-2); cursor: pointer; text-decoration: underline; text-decoration-color: transparent; transition: text-decoration-color 0.15s; }
.status-value.clickable:hover { text-decoration-color: var(--accent-2); }
.operator-help { margin: 8px 0 0; color: var(--text-muted); font-size: 11px; line-height: 1.4; }
.runtime-record-list { display: flex; flex-direction: column; gap: 6px; }
.record-row { display: flex; flex-direction: column; gap: 2px; text-align: left; background: var(--surface-1); border: 1px solid var(--surface-3); border-radius: 6px; padding: 7px 8px; color: var(--text); cursor: pointer; font-size: 11px; }
.record-row span:last-child { color: var(--text-muted); font-family: 'SF Mono', monospace; }
.list-empty { text-align: left; font-family: inherit; }
.index-bars { display: flex; flex-direction: column; gap: 6px; }
.index-bar-row { display: grid; grid-template-columns: 60px 1fr 30px; align-items: center; gap: 8px; }
.index-label { font-size: 11px; color: var(--text-muted); text-align: right; }
.index-bar-track { height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; }
.index-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent-2), var(--accent)); border-radius: 3px; min-width: 2px; transition: width 0.3s ease; }
.index-count { font-size: 11px; color: var(--text); font-family: 'SF Mono', monospace; text-align: right; }
.history-grid .status-key { font-size: 11px; }
</style>
