<template>
  <div class="dashboard-layout">
    <section class="status-panel runtime-console" aria-label="Runtime Console">
      <div class="panel-header">
        <h2 class="panel-title">Runtime Console</h2>
        <button
          class="refresh-btn"
          :disabled="runtimeLoading"
          @click="refreshRuntime"
          title="Refresh"
        >
          ↻
        </button>
      </div>

      <div v-if="runtimeBannerMessage" class="runtime-banner" :class="runtimeBannerClass">{{ runtimeBannerMessage }}</div>
      <div v-if="runtimeLoading && !runtime" class="status-loading">Loading...</div>

      <template v-else-if="errorMsg" class="status-error">
        <div class="error-banner">{{ errorMsg }}</div>
      </template>

      <template v-else>
        <div v-if="lastActionableError" class="status-section actionable-error" role="alert">
          <h3 class="section-label">Actionable Runtime Issue</h3>
          <p class="actionable-message">{{ lastActionableError.message }}</p>
          <p class="actionable-next">Next: {{ lastActionableError.nextAction }}</p>
          <div class="actionable-meta">
            <span v-if="lastActionableError.code">{{ lastActionableError.code }}</span>
            <span v-if="lastActionableError.cardId">card {{ lastActionableError.cardId }}</span>
            <span v-if="lastActionableError.runId">run {{ lastActionableError.runId }}</span>
          </div>
        </div>

        <div class="status-section">
          <h3 class="section-label">Runtime Intent</h3>
          <div class="status-grid">
            <div class="status-item">
              <span class="status-key">Intent</span>
              <span class="status-value">{{ intent?.status ?? 'unknown' }}</span>
            </div>
            <div class="status-item">
              <span class="status-key">Updated</span>
              <span class="status-value">{{ shortTime(intent?.updated_at) }}</span>
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
        </div>

        <div class="status-section">
          <h3 class="section-label">Root Run</h3>
          <div class="status-grid">
            <div class="status-item">
              <span class="status-key">Runtime</span>
              <span class="status-chip" :class="`rt-${statusLabel}`">
                <span class="chip-dot"></span>
                {{ statusLabel }}
              </span>
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
        </div>

        <div class="status-section runtime-record-list">
          <h3 class="section-label">
            Active Child Runs
            <span v-if="activeChildRuns.length" class="section-badge">{{ activeChildRuns.length }}</span>
          </h3>
          <div v-if="activeChildRuns.length === 0" class="status-value dim list-empty">none</div>
          <button v-for="run in activeChildRuns" :key="run.run_id" class="record-row" @click="goToCard(run.card_id)">
            <span>{{ run.card_id }}</span>
            <span>{{ run.phase }} · {{ run.runtime_status }}</span>
          </button>
        </div>

        <div class="status-section runtime-record-list">
          <h3 class="section-label">
            Activation Edges
            <span v-if="activations.length" class="section-badge">{{ activations.length }}</span>
          </h3>
          <div v-if="activations.length === 0" class="status-value dim list-empty">none</div>
          <button v-for="activation in activations.slice(-5).reverse()" :key="activation.activation_id" class="record-row" @click="goToCard(activation.child_card_id)">
            <span>{{ activation.parent_card_id }} → {{ activation.child_card_id }}</span>
            <span>{{ activation.status }} · {{ activation.precondition }}</span>
          </button>
        </div>

        <div class="status-section">
          <h3 class="section-label">Restart / Recovery Evidence</h3>
          <div class="status-grid">
            <div class="status-item">
              <span class="status-key">Last REST Sync</span>
              <span class="status-value">{{ shortTime(lastFetchedAt) }}</span>
            </div>
            <div class="status-item">
              <span class="status-key">Last WS Event</span>
              <span class="status-value">{{ shortTime(lastWsEventAt) }}</span>
            </div>
            <div class="status-item">
              <span class="status-key">Updated By</span>
              <span class="status-value">{{ lastUpdatedBy }}</span>
            </div>
          </div>
        </div>

        <div class="status-section">
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
        </div>


        <div class="status-section child-of-goal-panel" data-testid="dashboard-child-of-goal-panel">
          <h3 class="section-label">Displayed Card Children</h3>
          <ul data-testid="child-of-goal-list" class="child-of-goal-list">
            <li v-for="child in goalChildren" :key="child.id" data-testid="child-of-goal-item" class="child-of-goal-item">
              <span class="title">{{ child.title }}</span>
              <span class="status">{{ child.status }}</span>
            </li>
          </ul>
          <div v-if="goalChildren.length === 0" class="status-value dim list-empty">none</div>
        </div>

        <div class="status-section">
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
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { useRuntimeStore } from '../stores/runtime';
import { useCardStore } from '../stores/cards';
import type {
  CardRecord,
} from '../api/types';
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
  intent,
  currentRun,
  activeChildRuns,
  activations,
  doneGoals,
  failedBlocked,
  isStale: runtimeIsStale,
  isFrozen,
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

const displayedGoalId = computed<string | null>(() => cardsStore.currentCard?.id ?? null);
const goalChildren = computed<CardRecord[]>(() => displayedGoalId.value ? cardsStore.childrenOf(displayedGoalId.value) : []);
const runtimeBannerMessage = computed(() => {
  if (runtimeUnauthorized.value) return 'Runtime snapshot is unavailable because the API token was rejected.';
  if (isFrozen.value) return runtime.value?.frozen_reason || 'Runtime is frozen and needs operator attention.';
  if (statusLabel.value === 'error') return 'Runtime is degraded. Inspect Debug and current evidence before treating work as healthy.';
  if (runtimeIsStale.value) return 'Runtime snapshot is stale. Refresh to confirm the current REST state.';
  return null;
});
const runtimeBannerClass = computed(() => {
  if (runtimeUnauthorized.value || statusLabel.value === 'error') return 'runtime-banner-error';
  return 'runtime-banner-warning';
});

function shortTime(ts?: string | null): string {
  if (!ts) return 'unknown';
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ts; }
}

function goToCard(id: string): void {
  router.push({ name: 'card-detail', params: { id } });
}

function goToAgent(id: string): void {
  router.push({ name: 'agent-detail', params: { id } });
}

function barWidth(count: number): string {
  const max = Math.max(...Object.values(cardIndex.value.byType), 1);
  return `${Math.round((count / max) * 100)}%`;
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
  runtimeStore.setupWsListener();
});
</script>

<style scoped>
.dashboard-layout { display: flex; height: 100%; gap: 0; }
.status-panel { width: 100%; min-width: 0; flex: 1; overflow-y: auto; background: var(--bg); display: flex; flex-direction: column; }
.panel-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.panel-title { font-size: 13px; font-weight: 600; color: var(--text); margin: 0; }
.runtime-banner { margin: 12px 16px 0; padding: 10px 12px; border-radius: 6px; font-size: 12px; }
.runtime-banner-warning { background: var(--entry-warn-bg); border: 1px solid var(--entry-warn-border); color: var(--warn); }
.runtime-banner-error { background: var(--entry-danger-bg); border: 1px solid var(--danger); color: var(--danger); }
.refresh-btn { background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-muted); cursor: pointer; width: 28px; height: 28px; font-size: 14px; display: flex; align-items: center; justify-content: center; transition: color 0.15s, border-color 0.15s; }
.refresh-btn:hover:not(:disabled) { color: var(--accent-2); border-color: var(--accent-2); }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.status-loading,.status-error { padding: 16px; color: var(--text-muted); font-size: 12px; }
.error-banner { padding: 10px 12px; background: var(--entry-danger-bg); border: 1px solid var(--danger); border-radius: 4px; color: var(--danger); font-size: 12px; margin: 12px; }
.status-section { padding: 12px 16px; border-bottom: 1px solid var(--surface-3); }
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
.actionable-error { background: var(--entry-danger-bg); border-bottom-color: var(--danger); }
.actionable-message { margin: 0 0 6px; color: var(--text); font-size: 12px; line-height: 1.4; }
.actionable-next { margin: 0 0 6px; color: var(--orange); font-size: 12px; line-height: 1.4; }
.actionable-meta { display: flex; flex-wrap: wrap; gap: 6px; color: var(--text-muted); font: 10px 'SF Mono', monospace; }
.runtime-record-list { display: flex; flex-direction: column; gap: 6px; }
.record-row { display: flex; flex-direction: column; gap: 2px; text-align: left; background: var(--surface-1); border: 1px solid var(--surface-3); border-radius: 6px; padding: 7px 8px; color: var(--text); cursor: pointer; font-size: 11px; }
.record-row span:last-child { color: var(--text-muted); font-family: 'SF Mono', monospace; }
.list-empty { text-align: left; font-family: inherit; }
.status-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; font-family: inherit; border: 1px solid transparent; }
.chip-dot { width: 5px; height: 5px; border-radius: 50%; }
.rt-running { color: var(--accent); border-color: var(--accent); background: var(--entry-accent-bg); }
.rt-idle { color: var(--text-muted); border-color: var(--border-strong); background: var(--surface-3); }
.rt-paused { color: var(--warn); border-color: var(--entry-warn-border); background: var(--entry-warn-bg); }
.rt-frozen { color: var(--accent-2); border-color: var(--accent-2); background: var(--entry-user-bg); }
.rt-error { color: var(--danger); border-color: var(--danger); background: var(--entry-danger-bg); }
.rt-unknown { color: var(--text-muted); border-color: var(--border-strong); background: var(--surface-3); }
.rt-running .chip-dot { background: var(--accent); }
.rt-idle .chip-dot { background: var(--text-muted); }
.rt-paused .chip-dot { background: var(--warn); }
.rt-frozen .chip-dot { background: var(--accent-2); }
.rt-error .chip-dot { background: var(--danger); }
.rt-unknown .chip-dot { background: var(--text-muted); }
.index-bars { display: flex; flex-direction: column; gap: 6px; }
.index-bar-row { display: grid; grid-template-columns: 60px 1fr 30px; align-items: center; gap: 8px; }
.index-label { font-size: 11px; color: var(--text-muted); text-align: right; }
.index-bar-track { height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; }
.index-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent-2), var(--accent)); border-radius: 3px; min-width: 2px; transition: width 0.3s ease; }
.index-count { font-size: 11px; color: var(--text); font-family: 'SF Mono', monospace; text-align: right; }
.history-grid .status-key { font-size: 11px; }
</style>
