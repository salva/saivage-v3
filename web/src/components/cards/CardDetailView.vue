<template>
  <div class="card-detail-container">
    <ViewState v-if="loading" state="loading" title="Loading card" message="Fetching the latest card detail." />
    <StatusBanner v-else-if="detailError" tone="danger" :title="detailErrorTitle" :message="detailError.message">
      <template #action><button type="button" class="banner-action" @click="reloadDetail">Retry</button></template>
    </StatusBanner>
    <template v-else-if="currentCard">
      <EntityHeader
        data-testid="card-detail-highlight"
        :title="currentCard.title"
        :subtitle="currentCard.display_path"
        :type="labelForCardType(currentCard.type)"
        :status="cardUiStatus(currentCard.status, reason)"
      >
        <template #meta>
          <span class="ori-item"><span class="ori-key">v{{ currentCard.version_seq ?? '?' }}</span></span>
          <span v-if="currentCard.assigned_to" class="ori-item"><span class="ori-key">assigned</span> {{ currentCard.assigned_to }}</span>
          <span class="ori-item"><span class="ori-key">updated</span> {{ fmtDate(currentCard.updated_at) }}</span>
          <span v-if="lifecycle?.durationMs != null" class="ori-item"><span class="ori-key">duration</span> {{ lifecycle.durationMs }} ms</span>
        </template>

        <div v-if="reasonLine" class="card-entity__reason" :class="`tone-text-${toneForCardStatus(currentCard.status)}`">{{ reasonLine }}</div>

        <StatusBanner v-if="bannerSeverity" :tone="bannerSeverity" :message="bannerMessage">
          <template v-if="bannerSeverity === 'warning'" #action><button type="button" class="banner-action" @click="reloadDetail">Refresh card</button></template>
        </StatusBanner>
      </EntityHeader>

      <CardRecordsSection :card-id="currentCard.id" />

      <CardConversationsSection :card-id="currentCard.id" />

      <Section v-if="currentCard.notes && currentCard.notes.length" title="Notes &amp; activity">
        <div class="notes-list">
          <DocumentFrame v-for="note in currentCard.notes" :key="note.id" class="note-item" :class="{ 'note-handled': note.handled }" :title="note.kind" :writer="note.author" :timestamp="fmtDate(note.timestamp)">
            <MarkdownText :source="note.content" />
          </DocumentFrame>
        </div>
      </Section>

      <Section v-if="dispatches && (dispatches.outgoing.length || dispatches.incoming.length)" title="Dispatch summary">
        <div v-if="dispatches.outgoing.length" class="list-block">
          <div class="section-key">Outgoing</div>
          <div v-for="dispatch in dispatches.outgoing" :key="dispatch.dispatchId" class="verification-row">
            <button type="button" class="pill card-ref-button" @click="navigateCard(dispatch.targetCardId)">{{ dispatch.targetCardId }}</button>
            <StatusBadge :status="dispatchUiStatus(dispatch.status)" />
            <span v-if="dispatch.outcome" class="badge subtle">{{ dispatch.outcome }}</span>
            <span class="dispatch-summary">{{ dispatch.summary || 'No completion summary recorded.' }}</span>
          </div>
        </div>
        <div v-if="dispatches.incoming.length" class="list-block">
          <div class="section-key">Incoming</div>
          <div v-for="dispatch in dispatches.incoming" :key="dispatch.dispatchId" class="verification-row">
            <button type="button" class="pill card-ref-button" @click="navigateCard(dispatch.parentCardId)">{{ dispatch.parentCardId }}</button>
            <StatusBadge :status="dispatchUiStatus(dispatch.status)" />
            <span v-if="dispatch.outcome" class="badge subtle">{{ dispatch.outcome }}</span>
            <span class="dispatch-summary">{{ dispatch.summary || 'No completion summary recorded.' }}</span>
          </div>
        </div>
      </Section>

      <Section v-if="currentCard.lifecycle?.result" title="Result">
        <details class="result-disclosure">
          <summary class="result-summary">Raw result JSON ({{ resultSize }})</summary>
          <CodeBlock :code="formatJson(currentCard.lifecycle.result)" language="json" copyable />
        </details>
      </Section>

      <details class="disclosure">
        <summary class="disclosure-summary">Metadata</summary>
        <div class="meta-grid">
          <div class="meta-item"><span class="meta-key">ID</span><span class="meta-value mono">{{ currentCard.id }}</span></div>
          <div v-if="currentCard.display_path" class="meta-item"><span class="meta-key">Path</span><span class="meta-value mono">{{ currentCard.display_path }}</span></div>
          <div class="meta-item"><span class="meta-key">Created</span><span class="meta-value" :title="timestampTitle(currentCard.created_at)">{{ fmtDate(currentCard.created_at) }}</span></div>
          <div class="meta-item"><span class="meta-key">Updated</span><span class="meta-value" :title="timestampTitle(currentCard.updated_at)">{{ fmtDate(currentCard.updated_at) }}</span></div>
          <div class="meta-item"><span class="meta-key">Type</span><span class="meta-value">{{ labelForCardType(currentCard.type) }}</span></div>
          <div class="meta-item"><span class="meta-key">Urgency</span><span class="meta-value">{{ currentCard.urgency }}</span></div>
          <div v-if="currentCard.assigned_to" class="meta-item"><span class="meta-key">Assigned to</span><span class="meta-value">{{ currentCard.assigned_to }}</span></div>
          <div v-if="currentCard.started_at || lifecycle?.startedAt" class="meta-item"><span class="meta-key">Started</span><span class="meta-value" :title="timestampTitle(currentCard.started_at || lifecycle?.startedAt || '')">{{ fmtDate(currentCard.started_at || lifecycle?.startedAt || '') }}</span></div>
          <div v-if="currentCard.lifecycle?.completed_at || lifecycle?.completedAt" class="meta-item"><span class="meta-key">Completed</span><span class="meta-value" :title="timestampTitle(currentCard.lifecycle?.completed_at || lifecycle?.completedAt || '')">{{ fmtDate(currentCard.lifecycle?.completed_at || lifecycle?.completedAt || '') }}</span></div>
          <div class="meta-item"><span class="meta-key">Retries</span><span class="meta-value">{{ lifecycle?.retries ?? currentCard.retries }}</span></div>
        </div>
        <div v-if="currentCard.allowedActions?.length" class="allowed-actions" data-testid="allowed-actions">
          <span class="allowed-actions-label">Allowed actions:</span>
          <span v-for="action in currentCard.allowedActions" :key="action" class="allowed-action">{{ actionLabel(action) }}</span>
        </div>
      </details>

      <details class="disclosure" :open="historyOpen" @toggle="historyOpen = ($event.target as HTMLDetailsElement).open">
        <summary class="disclosure-summary">Version history</summary>
        <CardHistoryPanel v-if="historyOpen" :card-id="currentCard.id" />
      </details>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useCardStore } from '../../stores/cards';
import { storeToRefs } from 'pinia';
import type { DetailErrorState, CardStatus } from '../../types/view-models';
import { createLogger } from '../../utils/logger';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../../utils/timestamp';
import { toneForCardStatus, labelForCardType, type UiStatus } from '../../utils/status';
import CardHistoryPanel from './CardHistoryPanel.vue';
import CardRecordsSection from './CardRecordsSection.vue';
import CardConversationsSection from './CardConversationsSection.vue';
import Section from '../ui/Section.vue';
import EntityHeader from '../ui/EntityHeader.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import StatusBadge from '../ui/StatusBadge.vue';
import ViewState from '../ui/ViewState.vue';
import CodeBlock from '../content/CodeBlock.vue';
import DocumentFrame from '../content/DocumentFrame.vue';
import MarkdownText from '../content/MarkdownText.vue';
import { formatJson } from '../../utils/format-json';

const log = createLogger('comp:card-detail');
const props = defineProps<{ cardId: string }>();
const emit = defineEmits<{ navigate: [id: string] }>();
const cardStore = useCardStore();
const {
  currentCard,
  currentLifecycle: lifecycle,
  currentDispatches: dispatches,
  currentDetailError,
  currentDetailFreshness,
  currentCardHasStaleWarning,
  loading,
} = storeToRefs(cardStore);

const detailError = computed<DetailErrorState | null>(() => currentDetailError.value);

const historyOpen = ref(false);

function fmtDate(ts: string): string { return ts ? formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute') : ''; }
function statusExplainer(status: CardStatus): string {
  const map: Record<CardStatus, string> = {
    backlog: 'Planned but not started.',
    running: 'Running. Status records may be incomplete until the active work finishes.',
    blocked: 'Blocked. Check blockers, tool errors, review findings, and notes before retrying.',
    changed: 'Changed; needs planner attention before completion can proceed.',
    done: 'Marked done. Review status and review records before treating it as accepted.',
    failed: 'Failed. Inspect error, status records, and agent/review context.',
    cancelled: 'Cancelled; should not be treated as completed work.',
    needs_verification: 'Needs verification. Inspect status and review records before accepting or restarting.',
  };
  return map[status];
}

function cardUiStatus(status: CardStatus, description?: string): UiStatus {
  return { label: status, tone: toneForCardStatus(status), description };
}

function dispatchUiStatus(status: string): UiStatus {
  return { label: status, tone: status === 'completed' ? 'success' : 'neutral' };
}

const reason = computed(() => lifecycle.value?.explanation || statusExplainer(currentCard.value?.status ?? 'backlog'));
const PROBLEMATIC: ReadonlySet<CardStatus> = new Set(['failed', 'blocked', 'cancelled', 'needs_verification']);
const reasonLine = computed(() => {
  const status = currentCard.value?.status;
  if (!status || !PROBLEMATIC.has(status)) return '';
  return lifecycle.value?.explanation || statusExplainer(status);
});

const bannerSeverity = computed<'danger' | 'warning' | null>(() => {
  if (lifecycle.value?.error || currentCard.value?.lifecycle?.error) return 'danger';
  if (currentDetailFreshness.value.isStale || currentCardHasStaleWarning.value) return 'warning';
  return null;
});
const bannerMessage = computed(() => {
  if (bannerSeverity.value === 'danger') return `Card error: ${lifecycle.value?.error || currentCard.value?.lifecycle?.error}`;
  return 'This card detail may be stale. Refresh to reload canonical card data.';
});

const resultSize = computed(() => {
  const result = currentCard.value?.lifecycle?.result;
  if (!result) return '';
  try { return `${new Blob([JSON.stringify(result)]).size} B`; } catch { return ''; }
});

const detailErrorTitle = computed(() => {
  switch (detailError.value?.kind) {
    case 'unauthorized': return 'Unauthorized';
    case 'not-found': return 'Card not found';
    case 'server': return 'Card detail unavailable';
    case 'network': return 'Network error';
    default: return 'Card detail error';
  }
});
function navigateCard(id: string): void { emit('navigate', id); }
async function reloadDetail(): Promise<void> { try { await cardStore.fetchCardDetail(props.cardId); } catch (err) { log.error('fetch', err); } }

onMounted(async () => {
  await reloadDetail();
});

watch(() => props.cardId, async (nid, oldId) => {
  void oldId;
  if (nid) await reloadDetail();
});

function actionLabel(action: string): string {
  return action.replace('card.', '');
}
</script>

<style scoped>
.card-detail-container { flex:1; min-height:0; overflow-y:auto; padding:20px; }
.detail-loading { padding:16px; color:var(--text-muted); font-size:13px; }

.status-banner { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 12px; border-radius:6px; margin-top:10px; font-size:12px; }
.status-banner.tone-danger { background:var(--entry-danger-bg); color:var(--danger); }
.status-banner.tone-warning { background:var(--entry-warn-bg); color:var(--warn); }
.banner-action { padding:3px 10px; background:var(--surface-3); border:1px solid var(--border); color:var(--text); border-radius:4px; cursor:pointer; font:inherit; font-size:11px; }

.section-key { font-size:11px; font-weight:600; color:var(--text-muted); text-transform:uppercase; }
.pill-list { display:flex; flex-wrap:wrap; gap:8px; }
.children-list { display:flex; flex-direction:column; gap:6px; }
.child-row { text-align:left; cursor:pointer; background:var(--surface-1); border:1px solid var(--surface-3); border-radius:6px; padding:8px 12px; font:inherit; color:var(--text); }
.child-card-main { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.child-card-title { display:block; color:var(--text-muted); font-size:12px; margin-top:2px; }
.output-path { font-family:'SF Mono',monospace; font-size:12px; }

.notes-list { display:flex; flex-direction:column; gap:8px; }
.note-item.note-handled { opacity:0.65; }

.list-block { margin-bottom:10px; }
.list-block:last-child { margin-bottom:0; }
.verification-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:6px 0; }
.dispatch-summary { color:var(--text-muted); font-size:12px; }
.badge.subtle { color:var(--text-muted); font-size:11px; padding:2px 8px; border-radius:4px; background:var(--surface-3); border:1px solid var(--border); }
.pill { padding:6px 10px; background:var(--surface-3); border:1px solid var(--border); color:var(--text); border-radius:4px; cursor:pointer; }

.result-disclosure > summary { list-style:none; cursor:pointer; font-size:12px; color:var(--text-muted); }
.result-disclosure > summary::-webkit-details-marker { display:none; }
.result-disclosure > summary::before { content:'▸ '; }
.result-disclosure[open] > summary::before { content:'▾ '; }
.result-disclosure[open] > summary { margin-bottom:8px; }

.disclosure { border-top:1px solid var(--surface-3); padding:12px 0; }
.disclosure > summary { list-style:none; cursor:pointer; font-size:13px; font-weight:600; color:var(--text); }
.disclosure > summary::-webkit-details-marker { display:none; }
.disclosure > summary::before { content:'▸ '; color:var(--text-muted); }
.disclosure[open] > summary::before { content:'▾ '; }
.disclosure[open] > summary { margin-bottom:10px; }
.meta-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:8px; }
.meta-item { display:flex; flex-direction:column; gap:2px; }
.meta-key { font-size:11px; color:var(--text-muted); }
.meta-value { font-size:13px; color:var(--text); }
.meta-value.mono { font-family:'SF Mono',monospace; font-size:12px; }
.allowed-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; align-items:center; }
.allowed-actions-label { font-size:11px; color:var(--text-muted); }
.allowed-action { font-size:11px; padding:2px 6px; border-radius:999px; color:var(--accent-2); border:1px solid var(--accent-2); opacity:.7; }
</style>
