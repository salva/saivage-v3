<template>
  <div class="dashboard-layout" data-testid="route-dashboard">
    <Panel as="section" :padded="false" scroll class="runtime-console" aria-label="Runtime Console">
      <div class="console-header">
        <PanelHeader title="Runtime Console">
          <template #actions>
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
        <ViewState v-if="runtimeLoading && !runtime" state="loading" title="Loading runtime state" />
        <ViewState v-else-if="errorMsg" state="error" title="Failed to load runtime" :message="errorMsg" />

        <template v-else>
          <section v-if="lastActionableError || currentRun || doneGoals || failedBlocked" class="status-section mission-summary">
            <StatusBanner v-if="lastActionableError" tone="danger" :title="lastActionableError.message" :message="`Next: ${lastActionableError.nextAction}`" role="alert" />
            <div v-if="currentRun" class="mission-active">
              <span class="status-key">Active card</span>
              <button class="mission-active-link" @click="goToCard(currentRun.card_id)">
                <span class="mission-active-title">{{ activeCardTitle }}</span>
                <span class="mission-active-phase">{{ currentRun.phase }}</span>
              </button>
            </div>
            <div class="mission-stats">
              <span class="mission-stat success"><strong>{{ doneGoals }}</strong> done</span>
              <span class="mission-stat" :class="{ danger: failedBlocked }"><strong>{{ failedBlocked }}</strong> failed/blocked</span>
              <span class="mission-stat"><strong>{{ cardIndex.total }}</strong> total</span>
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
                <span class="status-key">Live State</span>
                <span class="status-value">{{ liveUpdateLabel }}</span>
              </div>
              <div class="status-item">
                <span class="status-key">Last Command</span>
                <span class="status-value">{{ lastCommand ? `${lastCommand.command} · ${lastCommand.status}` : 'none' }}</span>
              </div>
            </div>
            <p class="operator-help">{{ liveUpdateDetail }}</p>
          </section>

          <section class="status-section">
            <h3 class="section-label">Root Run</h3>
            <div class="status-grid">
              <div class="status-item">
                <span class="status-key">Runtime</span>
                <StatusBadge :status="statusForRuntimeStatus(statusLabel)" show-dot />
              </div>
              <div class="status-item">
                <span class="status-key">Current Run</span>
                <span v-if="currentRun" class="status-value clickable" @click="goToCard(currentRun.card_id)">
                  {{ currentRun.card_id }} · {{ currentRun.phase }}
                </span>
                <span v-else class="status-value dim">none</span>
              </div>
              <div class="status-item">
                <span class="status-key">Session</span>
                <span v-if="currentRun?.session_id" class="status-value clickable" @click="goToAgent(currentRun.session_id)">{{ currentRun.session_id.slice(0, 12) }}...</span>
                <span v-else-if="currentAgentSessionId" class="status-value clickable" @click="goToAgent(currentAgentSessionId)">{{ currentAgentSessionId.slice(0, 12) }}...</span>
                <span v-else class="status-value dim">none</span>
              </div>
            </div>
          </section>

          <section class="status-section runtime-record-list">
            <h3 class="section-label">
              Active Child Runs
              <span v-if="activeChildRuns.length" class="section-badge">{{ activeChildRuns.length }}</span>
            </h3>
            <div v-if="activeChildRuns.length === 0" class="status-value dim list-empty">none</div>
            <button v-for="run in activeChildRuns" :key="run.run_id" class="record-row" @click="goToCard(run.card_id)">
              <span>{{ run.card_id }}</span>
              <span>{{ run.phase }} · {{ run.runtime_status }}</span>
            </button>
          </section>

          <section class="status-section runtime-record-list">
            <h3 class="section-label">
              Activation Edges
              <span v-if="activations.length" class="section-badge">{{ activations.length }}</span>
            </h3>
            <div v-if="activations.length === 0" class="status-value dim list-empty">none</div>
            <button v-for="activation in activations.slice(-5).reverse()" :key="activation.activation_id" class="record-row" @click="goToCard(activation.child_card_id)">
              <span>{{ activation.parent_card_id }} → {{ activation.child_card_id }}</span>
              <span>{{ activation.status }} · {{ activation.precondition }}</span>
            </button>
          </section>

          <section class="status-section">
            <h3 class="section-label">Restart / Recovery Evidence</h3>
            <div class="status-grid">
              <div class="status-item">
                <span class="status-key">Last REST Sync</span>
                <span class="status-value" :title="shortTimeTitle(lastFetchedAt)">{{ shortTime(lastFetchedAt) }}</span>
              </div>
              <div class="status-item">
                <span class="status-key">Last WS Event</span>
                <span class="status-value" :title="shortTimeTitle(lastWsEventAt)">{{ shortTime(lastWsEventAt) }}</span>
              </div>
              <div class="status-item">
                <span class="status-key">Updated By</span>
                <span class="status-value">{{ lastUpdatedBy }}</span>
              </div>
            </div>
          </section>

          <section class="status-section">
            <h3 class="section-label">Recent History</h3>
            <div class="status-grid history-grid">
              <div class="status-item">
                <span class="status-key">Done Goals</span>
                <span class="status-value success">{{ doneGoals }}</span>
              </div>
              <div class="status-item">
                <span class="status-key">Failed/Blocked</span>
                <span class="status-value" :class="failedBlocked ? 'danger' : ''">{{ failedBlocked }}</span>
              </div>
              <div class="status-item">
                <span class="status-key">Total Cards</span>
                <span class="status-value">{{ cardIndex.total }}</span>
              </div>
            </div>
          </section>

          <section class="status-section child-of-goal-panel" data-testid="dashboard-child-of-goal-panel">
            <h3 class="section-label">Displayed Card Children</h3>
            <ul data-testid="child-of-goal-list" class="child-of-goal-list">
              <li v-for="child in goalChildren" :key="child.id" data-testid="child-of-goal-item" class="child-of-goal-item">
                <span class="title">{{ child.title }}</span>
                <span class="status">{{ child.status }}</span>
              </li>
            </ul>
            <div v-if="goalChildren.length === 0" class="status-value dim list-empty">none</div>
          </section>

          <section class="status-section">
            <h3 class="section-label">Card Index</h3>
            <div class="index-bars">
              <div v-for="(count, name) in cardIndex.byType" :key="name" class="index-bar-row">
                <span class="index-label">{{ name }}</span>
                <div class="index-bar-track">
                  <div class="index-bar-fill" :style="{ width: barWidth(count) }"></div>
                </div>
                <span class="index-count">{{ count }}</span>
              </div>
            </div>
          </section>
        </template>
      </div>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { useRuntimeStore } from '../stores/runtime';
import { useCardStore } from '../stores/cards';
import { useDashboardReadModel } from '../composables/useDashboardReadModel';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../utils/timestamp';
import { statusForRuntimeStatus, type Tone } from '../utils/status';
import Panel from '../components/ui/Panel.vue';
import PanelHeader from '../components/ui/PanelHeader.vue';
import StatusBanner from '../components/ui/StatusBanner.vue';
import ViewState from '../components/ui/ViewState.vue';
import StatusBadge from '../components/ui/StatusBadge.vue';

const runtimeStore = useRuntimeStore();
const cardsStore = useCardStore();
const router = useRouter();

const {
  runtime,
  cardIndex,
  loading: runtimeLoading,
  statusLabel,
  currentCardId,
  currentAgentSessionId,
  currentRun,
  activeChildRuns,
  activations,
  doneGoals,
  failedBlocked,
  isStale: runtimeIsStale,
  unauthorized: runtimeUnauthorized,
  lastCommand,
  lastActionableError,
  liveUpdateLabel,
  liveUpdateDetail,
  lastFetchedAt,
  lastWsEventAt,
  lastUpdatedBy,
} = storeToRefs(runtimeStore);

const errorMsg = ref<string | null>(null);

const { goalChildren, runtimeBannerMessage, runtimeBannerClass, barWidth } = useDashboardReadModel({
  runtimeRefs: {
    statusLabel,
    isStale: runtimeIsStale,
    unauthorized: runtimeUnauthorized,
    cardIndex,
  },
  cardsStore,
});

const runtimeBannerTone = computed<Tone>(() => runtimeBannerClass.value === 'runtime-status-banner-error' ? 'danger' : 'warning');
const activeCardTitle = computed(() => {
  const id = currentRun.value?.card_id ?? currentCardId.value;
  if (!id) return id ?? 'none';
  const card = cardsStore.cards.find((c) => c.id === id);
  return card?.title ?? id;
});

function shortTime(ts?: string | null): string {
  if (!ts) return 'unknown';
  return formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute');
}
function shortTimeTitle(ts?: string | null): string {
  return ts ? timestampTitle(ts) : '';
}

function goToCard(id: string): void {
  router.push({ name: 'card-detail', params: { id } });
}

function goToAgent(id: string): void {
  router.push({ name: 'agent-detail', params: { id } });
}

async function refreshRuntime(): Promise<void> {
  errorMsg.value = null;
  try {
    await runtimeStore.fetchState();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed';
    errorMsg.value = msg;
  }
}

onMounted(async () => {
  await refreshRuntime();
});
</script>

<style scoped>
.dashboard-layout { display: flex; height: 100%; gap: 0; }
.runtime-console { width: 100%; min-width: 0; flex: 1; background: var(--bg); }
.console-header { padding: 12px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.console-header :deep(.ui-panel-header) { margin-bottom: 0; }
.console-body { padding: 4px 0; }
.console-body :deep(.status-banner) { margin: 8px 16px; }
.console-body :deep(.view-state) { padding: 16px; }
.ui-refresh-button { background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-muted); cursor: pointer; width: 28px; height: 28px; font-size: 14px; display: flex; align-items: center; justify-content: center; transition: color 0.15s, border-color 0.15s; }
.ui-refresh-button:hover:not(:disabled) { color: var(--accent-2); border-color: var(--accent-2); }
.ui-refresh-button:disabled { opacity: 0.5; cursor: not-allowed; }
.status-section { padding: 12px 16px; border-bottom: 1px solid var(--surface-3); }
.mission-summary { display: flex; flex-direction: column; gap: var(--space-5); }
.mission-summary :deep(.status-banner) { margin: 0; }
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
