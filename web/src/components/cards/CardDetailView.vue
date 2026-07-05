<template>
  <div class="card-detail-container">
    <div v-if="loading" class="detail-loading">Loading card...</div>
    <div v-else-if="detailError" class="status-banner tone-danger" role="alert">
      <strong>{{ detailErrorTitle }}</strong>
      <div>{{ detailError.message }}</div>
      <button type="button" class="banner-action" @click="reloadDetail">Retry</button>
    </div>
    <template v-else-if="currentCard">
      <header class="card-entity" :class="{ 'live-highlight': liveHighlighted }" data-testid="card-detail-highlight">
        <div class="card-entity__title-row">
          <h1 class="card-entity__title">
            <span v-if="currentCard.display_path" class="card-entity__path">{{ currentCard.display_path }}</span>
            <span class="card-entity__name">{{ currentCard.title }}</span>
          </h1>
          <span class="card-entity__type">{{ labelForCardType(currentCard.type) }}</span>
          <StatusBadge
            :tone="toneForCardStatus(currentCard.status)"
            :label="currentCard.status"
            :title="reason"
          />
          <button type="button" class="discuss-btn" aria-label="Seed analyst chat with this card" @click="seedAnalystForCard">Discuss with analyst</button>
        </div>

        <div class="card-entity__orientation">
          <span class="ori-item"><span class="ori-key">v{{ currentCard.version_seq ?? '?' }}</span></span>
          <span class="ori-item"><span class="ori-key">priority</span> {{ currentCard.priority }}</span>
          <span v-if="currentCard.assigned_to" class="ori-item"><span class="ori-key">assigned</span> {{ currentCard.assigned_to }}</span>
          <span class="ori-item"><span class="ori-key">updated</span> {{ fmtDate(currentCard.updated_at) }}</span>
          <span v-if="lifecycle?.durationMs != null" class="ori-item"><span class="ori-key">duration</span> {{ lifecycle.durationMs }} ms</span>
        </div>

        <div v-if="reasonLine" class="card-entity__reason" :class="`tone-text-${toneForCardStatus(currentCard.status)}`">{{ reasonLine }}</div>

        <div v-if="bannerSeverity" class="status-banner" :class="`tone-${bannerSeverity}`" :role="bannerSeverity === 'danger' ? 'alert' : 'status'">
          <span>{{ bannerMessage }}</span>
          <button v-if="bannerSeverity === 'warning'" type="button" class="banner-action" @click="reloadDetail">Refresh card</button>
        </div>
      </header>

      <CardRecordsSection :card-id="currentCard.id" />

      <CardConversationsSection :card-id="currentCard.id" />

      <Section v-if="currentChildren.length || currentAncestorRefs.length || currentCard.depends_on.length" title="Hierarchy">
        <div v-if="currentAncestorRefs.length" class="hierarchy-row">
          <span class="hierarchy-key">Ancestors</span>
          <div class="pill-list">
            <CardRefLink v-for="ancestorRef in currentAncestorRefs" :key="ancestorRef.id" :ref-view="ancestorRef" @navigate="navigateCard" />
          </div>
        </div>
        <div v-if="currentChildren.length" class="hierarchy-row">
          <span class="hierarchy-key">Children</span>
          <div class="children-list">
            <button v-for="child in currentChildren" :key="child.id" type="button" class="child-row" @click="navigateCard(child.id)">
              <span class="child-card-main">
                <span class="output-path">{{ child.display_path || child.id }}</span>
                <StatusBadge :tone="toneForCardStatus(child.status)" :label="child.status" />
              </span>
              <span class="child-card-title">{{ child.title }}</span>
            </button>
          </div>
        </div>
        <div v-if="currentCard.depends_on.length" class="hierarchy-row">
          <span class="hierarchy-key">Blocking dependencies</span>
          <div class="pill-list">
            <CardRefLink v-for="depRef in dependencyRefs" :key="depRef.id" :ref-view="depRef" @navigate="navigateCard" />
          </div>
        </div>
      </Section>

      <Section v-if="currentCard.notes && currentCard.notes.length" title="Notes &amp; activity">
        <div class="notes-list">
          <div v-for="note in currentCard.notes" :key="note.id" class="note-item" :class="{ 'note-handled': note.handled }">
            <div class="note-header">
              <span class="note-author">{{ note.author }}</span>
              <span class="note-kind-badge">{{ note.kind }}</span>
              <span class="note-time" :title="timestampTitle(note.timestamp)">{{ fmtDate(note.timestamp) }}</span>
            </div>
            <div class="note-content" v-html="renderMarkdown(note.content)"></div>
          </div>
        </div>
      </Section>

      <Section v-if="dispatches && (dispatches.outgoing.length || dispatches.incoming.length)" title="Dispatch summary">
        <div v-if="dispatches.outgoing.length" class="list-block">
          <div class="hierarchy-key">Outgoing</div>
          <div v-for="dispatch in dispatches.outgoing" :key="dispatch.dispatchId" class="verification-row">
            <button type="button" class="pill card-ref-button" @click="navigateCard(dispatch.targetCardId)">{{ dispatch.targetCardId }}</button>
            <StatusBadge :tone="dispatch.status === 'completed' ? 'success' : 'neutral'" :label="dispatch.status" />
            <span v-if="dispatch.outcome" class="badge subtle">{{ dispatch.outcome }}</span>
            <span class="dispatch-summary">{{ dispatch.summary || 'No completion summary recorded.' }}</span>
          </div>
        </div>
        <div v-if="dispatches.incoming.length" class="list-block">
          <div class="hierarchy-key">Incoming</div>
          <div v-for="dispatch in dispatches.incoming" :key="dispatch.dispatchId" class="verification-row">
            <button type="button" class="pill card-ref-button" @click="navigateCard(dispatch.parentCardId)">{{ dispatch.parentCardId }}</button>
            <StatusBadge :tone="dispatch.status === 'completed' ? 'success' : 'neutral'" :label="dispatch.status" />
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
          <div class="meta-item"><span class="meta-key">Priority</span><span class="meta-value" :class="{ high: currentCard.priority >= 80 }">{{ currentCard.priority }}</span></div>
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
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useAnalystChat } from '../../stores/analystChat';
import { useCardStore } from '../../stores/cards';
import { storeToRefs } from 'pinia';
import type { DetailErrorState, CardStatus } from '../../types/view-models';
import { createLogger } from '../../utils/logger';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../../utils/timestamp';
import { toneForCardStatus, labelForCardType } from '../../utils/status';
import CardHistoryPanel from './CardHistoryPanel.vue';
import CardRefLink from './CardRefLink.vue';
import CardRecordsSection from './CardRecordsSection.vue';
import CardConversationsSection from './CardConversationsSection.vue';
import Section from '../ui/Section.vue';
import StatusBadge from '../ui/StatusBadge.vue';
import CodeBlock from '../content/CodeBlock.vue';
import { formatJson } from '../../utils/format-json';

const log = createLogger('comp:card-detail');
const props = defineProps<{ cardId: string }>();
const emit = defineEmits<{ navigate: [id: string] }>();
const cardStore = useCardStore();
const analystChat = useAnalystChat();
const {
  currentCard,
  currentChildren,
  currentAncestorRefs,
  currentLifecycle: lifecycle,
  currentDispatches: dispatches,
  currentDetailError,
  currentDetailFreshness,
  currentCardHasStaleWarning,
  loading,
} = storeToRefs(cardStore);

const detailError = computed<DetailErrorState | null>(() => currentDetailError.value);

const liveHighlighted = ref(false);
const historyOpen = ref(false);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

function fmtDate(ts: string): string { return ts ? formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute') : ''; }
function esc(text: string): string { return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function renderMarkdown(text: string): string { return esc(text).replace(/\n/g, '<br>'); }

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

const dependencyRefs = computed(() => currentCard.value?.dependencyRefs ?? currentCard.value?.depends_on.map((id) => ({ id, display_path: null, title: null })) ?? []);
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

function clearHighlightTimer(): void {
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
}

async function seedAnalystForCard(): Promise<void> {
  if (!currentCard.value) return;
  if (analystChat.hasDraft && typeof window !== 'undefined') {
    const shouldReseed = window.confirm('You have an in-progress analyst draft. Reseed the chat with this card context?');
    if (!shouldReseed) {
      window.dispatchEvent(new CustomEvent('saivage:focus-chat'));
      return;
    }
  }
  analystChat.seedCardContext(currentCard.value);
  await analystChat.fetchMessages(analystChat.activeSessionId).catch(() => {});
  window.dispatchEvent(new CustomEvent('saivage:focus-chat'));
}

onMounted(async () => {
  await reloadDetail();
});

onBeforeUnmount(() => {
  clearHighlightTimer();
});

watch(() => props.cardId, async (nid, oldId) => {
  void oldId;
  liveHighlighted.value = false;
  clearHighlightTimer();
  if (nid) await reloadDetail();
});

function actionLabel(action: string): string {
  return action.replace('card.', '');
}
</script>

<style scoped>
.card-detail-container { flex:1; overflow-y:auto; padding:20px; }
.detail-loading { padding:16px; color:var(--text-muted); font-size:13px; }

.card-entity { padding-bottom:8px; }
.card-entity.live-highlight { box-shadow:0 0 0 1px rgba(31,111,235,.45), 0 0 16px rgba(31,111,235,.18); border-radius:6px; transition:box-shadow .2s ease; }
.card-entity__title-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.card-entity__title { font-size:20px; font-weight:600; color:var(--text); margin:0; flex:1; min-width:0; display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
.card-entity__path { color:var(--accent-2); font-family:'SF Mono',monospace; font-size:18px; }
.card-entity__name { color:var(--text); }
.card-entity__type { font-size:12px; font-weight:600; color:var(--text); padding:2px 8px; border-radius:4px; background:var(--surface-3); border:1px solid var(--border); }
.card-entity__orientation { display:flex; flex-wrap:wrap; gap:14px; margin-top:8px; font-size:12px; color:var(--text-muted); }
.ori-key { color:var(--text-muted); margin-right:3px; }
.card-entity__reason { font-size:12px; margin-top:8px; }
.tone-text-danger { color:var(--danger); }
.tone-text-warning { color:var(--warn); }

.status-banner { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 12px; border-radius:6px; margin-top:10px; font-size:12px; }
.status-banner.tone-danger { background:var(--entry-danger-bg); color:var(--danger); }
.status-banner.tone-warning { background:var(--entry-warn-bg); color:var(--warn); }
.banner-action { padding:3px 10px; background:var(--surface-3); border:1px solid var(--border); color:var(--text); border-radius:4px; cursor:pointer; font:inherit; font-size:11px; }

.discuss-btn { margin-left:auto; border:1px solid var(--accent-2); background:var(--bg); color:var(--accent-2); border-radius:999px; padding:6px 10px; cursor:pointer; }

.hierarchy-row { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
.hierarchy-row:last-child { margin-bottom:0; }
.hierarchy-key { font-size:11px; font-weight:600; color:var(--text-muted); text-transform:uppercase; }
.pill-list { display:flex; flex-wrap:wrap; gap:8px; }
.children-list { display:flex; flex-direction:column; gap:6px; }
.child-row { text-align:left; cursor:pointer; background:var(--surface-1); border:1px solid var(--surface-3); border-radius:6px; padding:8px 12px; font:inherit; color:var(--text); }
.child-card-main { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.child-card-title { display:block; color:var(--text-muted); font-size:12px; margin-top:2px; }
.output-path { font-family:'SF Mono',monospace; font-size:12px; }

.notes-list { display:flex; flex-direction:column; gap:8px; }
.note-item { background:var(--surface-1); border:1px solid var(--surface-3); border-radius:6px; padding:10px 12px; }
.note-item.note-handled { opacity:0.65; }
.note-header { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
.note-author { font-size:12px; font-weight:600; }
.note-kind-badge { font-size:10px; padding:1px 6px; border-radius:8px; background:var(--surface-3); color:var(--text-muted); text-transform:uppercase; }
.note-time { font-size:11px; color:var(--text-muted); margin-left:auto; font-family:'SF Mono',monospace; }
.note-content { color:var(--text-muted); font-size:12px; }

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
.meta-value.high { color:var(--danger); font-weight:600; }
.allowed-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; align-items:center; }
.allowed-actions-label { font-size:11px; color:var(--text-muted); }
.allowed-action { font-size:11px; padding:2px 6px; border-radius:999px; color:var(--accent-2); border:1px solid var(--accent-2); opacity:.7; }
</style>
