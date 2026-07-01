<template>
  <div class="card-detail-container">
    <div v-if="loading" class="detail-loading">Loading card...</div>
    <div v-else-if="detailError" class="detail-callout error" role="alert">
      <strong>{{ detailErrorTitle }}</strong>
      <div>{{ detailError.message }}</div>
      <button type="button" class="retry-btn" @click="reloadDetail">Retry</button>
    </div>
    <template v-else-if="currentCard">
      <section class="detail-section header-section" :class="{ 'live-highlight': liveHighlighted }" data-testid="card-detail-highlight">
        <div class="detail-title-row">
          <span class="detail-type-badge" :class="'type-' + currentCard.type">{{ typeIcon(currentCard.type) }} {{ currentCard.type }}</span>
          <h1 class="detail-title"><span v-if="currentCard.display_path" class="detail-display-path">{{ currentCard.display_path }}</span>{{ currentCard.title }}</h1>
          <span class="detail-status-chip" :class="'status-' + currentCard.status">{{ currentCard.status }}</span>
          <button type="button" class="discuss-btn" aria-label="Seed analyst chat with this card" @click="seedAnalystForCard">Discuss with analyst</button>
        </div>
        <div class="detail-id">ID: {{ currentCard.id }}<span v-if="currentCard.display_path"> · Path: {{ currentCard.display_path }}</span></div>
        <div class="detail-callout" role="status">{{ lifecycle?.explanation || statusExplainer(currentCard.status) }}</div>
        <div v-if="detailFreshness.isStale" class="detail-callout warning" role="status">
          This card detail may be stale. Refresh to reload canonical card data from the server.
          <button type="button" class="retry-btn" @click="reloadDetail">Refresh card</button>
        </div>
        <StaleWarningRibbon :card-id="currentCard.id" />
        <div v-if="lifecycle?.error || currentCard.lifecycle?.error" class="detail-callout error" role="alert">
          Card error: {{ lifecycle?.error || currentCard.lifecycle?.error }}
        </div>
      </section>

      <section v-if="currentCard.allowedActions?.length" class="detail-section">
        <h3 class="section-heading">Allowed actions</h3>
        <div class="allowed-actions" data-testid="allowed-actions">
          <span v-for="action in currentCard.allowedActions" :key="action" class="allowed-action">{{ actionLabel(action) }}</span>
        </div>
      </section>

      <section class="detail-section">
        <h3 class="section-heading">Metadata</h3>
        <div class="meta-grid">
          <div class="meta-item"><span class="meta-key">Created</span><span class="meta-value" :title="timestampTitle(currentCard.created_at)">{{ fmtDate(currentCard.created_at) }}</span></div>
          <div class="meta-item"><span class="meta-key">Updated</span><span class="meta-value" :title="timestampTitle(currentCard.updated_at)">{{ fmtDate(currentCard.updated_at) }}</span></div>
          <div class="meta-item"><span class="meta-key">Version</span><span class="meta-value">{{ currentCard.version_seq ?? 'unknown' }}</span></div>
          <div v-if="currentCard.started_at || lifecycle?.startedAt" class="meta-item"><span class="meta-key">Started</span><span class="meta-value" :title="timestampTitle(currentCard.started_at || lifecycle?.startedAt || '')">{{ fmtDate(currentCard.started_at || lifecycle?.startedAt || '') }}</span></div>
          <div v-if="currentCard.lifecycle?.completed_at || lifecycle?.completedAt" class="meta-item"><span class="meta-key">Completed</span><span class="meta-value" :title="timestampTitle(currentCard.lifecycle?.completed_at || lifecycle?.completedAt || '')">{{ fmtDate(currentCard.lifecycle?.completed_at || lifecycle?.completedAt || '') }}</span></div>
          <div class="meta-item"><span class="meta-key">Priority</span><span class="meta-value" :class="{ high: currentCard.priority >= 80 }">{{ currentCard.priority }}</span></div>
          <div class="meta-item"><span class="meta-key">Urgency</span><span class="meta-value">{{ currentCard.urgency }}</span></div>
          <div v-if="currentCard.assigned_to" class="meta-item"><span class="meta-key">Assigned to</span><span class="meta-value">{{ currentCard.assigned_to }}</span></div>
          <div v-if="lifecycle?.durationMs != null" class="meta-item"><span class="meta-key">Duration</span><span class="meta-value">{{ lifecycle.durationMs }} ms</span></div>
          <div class="meta-item"><span class="meta-key">Retries</span><span class="meta-value">{{ lifecycle?.retries ?? currentCard.retries }}</span></div>
        </div>
      </section>

      <CardHistoryPanel :card-id="currentCard.id" />

      <section class="detail-section">
        <h3 class="section-heading">Completion &amp; blockers</h3>
        <div class="meta-grid">
          <div class="meta-item"><span class="meta-key">Completion state</span><span class="meta-value">{{ completionLabel }}</span></div>
          <div class="meta-item"><span class="meta-key">Record outputs</span><span class="meta-value">Status and review records are stored under the card output slots.</span></div>
          <div class="meta-item"><span class="meta-key">Child work</span><span class="meta-value">{{ childWorkSummary }}</span></div>
        </div>
        <div v-if="currentCard.depends_on.length" class="link-list-row">
          <span class="meta-key">Blocking dependencies</span>
          <div class="pill-list">
            <CardRefLink v-for="depRef in dependencyRefs" :key="depRef.id" :ref-view="depRef" @navigate="navigateCard" />
          </div>
        </div>
        <div v-if="planning" class="planning-summary">
          <strong>Planning</strong>
          <div>Status: {{ planning.status || 'unknown' }}</div>
          <div v-if="planning.summary">{{ planning.summary }}</div>
          <div v-if="planning.blockedReason" class="detail-callout warning">Blocked reason: {{ planning.blockedReason }}</div>
          <div v-if="planning.reviewSummary">Review summary: {{ planning.reviewSummary }}</div>
          <div v-if="planning.hasUnfinishedChildWork" class="detail-callout warning">Planner declared work done, but unfinished child work is still indicated.</div>
        </div>
      </section>

      <section class="detail-section">
        <h3 class="section-heading">Hierarchy</h3>
        <div v-if="currentAncestorRefs.length" class="link-list-row">
          <span class="meta-key">Ancestors</span>
          <div class="pill-list">
            <CardRefLink v-for="ancestorRef in currentAncestorRefs" :key="ancestorRef.id" :ref-view="ancestorRef" @navigate="navigateCard" />
          </div>
        </div>
        <div v-if="currentChildren.length" class="children-list">
          <button v-for="child in currentChildren" :key="child.id" type="button" class="child-row" @click="navigateCard(child.id)">
            <span class="child-card-main">
              <span class="output-path">{{ child.display_path || child.id }}</span>
              <span class="badge">{{ child.type }}</span>
              <span class="badge" :class="statusBadgeClass(child.status)">{{ child.status }}</span>
            </span>
            <span class="child-card-title">{{ child.title }}</span>
          </button>
        </div>
        <div v-else class="empty-evidence">No child cards are recorded for this card.</div>
      </section>

      <section class="detail-section">
        <h3 class="section-heading">Record outputs</h3>
        <div class="evidence-summary">Agent status and review output is persisted as versioned record slots.</div>
        <div class="meta-grid">
          <div class="meta-item"><span class="meta-key">Output directory</span><code class="inline-token output-path">.saivage/outputs/cards/{{ currentCard.id }}/</code></div>
          <div class="meta-item"><span class="meta-key">Common slots</span><span class="meta-value">status.md, review.md</span></div>
        </div>
        <div class="empty-evidence">No dedicated record-slot API projection is available in this view yet. Use Files to inspect the output directory.</div>
      </section>

      <section class="detail-section" v-if="dispatches && (dispatches.outgoing.length || dispatches.incoming.length)">
        <h3 class="section-heading">Dispatch summary</h3>
        <div v-if="dispatches.outgoing.length" class="list-block">
          <div class="meta-key">Outgoing dispatches</div>
          <div v-for="dispatch in dispatches.outgoing" :key="dispatch.dispatchId" class="verification-row">
            <button type="button" class="pill card-ref-button" @click="navigateCard(dispatch.targetCardId)">{{ dispatch.targetCardId }}</button>
            <span class="badge">{{ dispatch.status }}</span>
            <span v-if="dispatch.outcome" class="badge subtle">{{ dispatch.outcome }}</span>
            <span>{{ dispatch.summary || 'No completion summary recorded.' }}</span>
          </div>
        </div>
        <div v-if="dispatches.incoming.length" class="list-block">
          <div class="meta-key">Incoming dispatches</div>
          <div v-for="dispatch in dispatches.incoming" :key="dispatch.dispatchId" class="verification-row">
            <button type="button" class="pill card-ref-button" @click="navigateCard(dispatch.parentCardId)">{{ dispatch.parentCardId }}</button>
            <span class="badge">{{ dispatch.status }}</span>
            <span v-if="dispatch.outcome" class="badge subtle">{{ dispatch.outcome }}</span>
            <span>{{ dispatch.summary || 'No completion summary recorded.' }}</span>
          </div>
        </div>
      </section>

      <section v-if="currentCard.notes && currentCard.notes.length" class="detail-section">
        <h3 class="section-heading">Notes &amp; Activity</h3>
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
      </section>

      <section v-if="currentCard.lifecycle?.result" class="detail-section">
        <h3 class="section-heading">Result</h3>
        <CodeBlock :code="formatJson(currentCard.lifecycle.result)" language="json" copyable />
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useAnalystChat } from '../../stores/analystChat';
import { useCardStore } from '../../stores/cards';
import { storeToRefs } from 'pinia';
import type { DetailErrorState, CardStatus } from '../../api/types';
import { createLogger } from '../../utils/logger';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../../utils/timestamp';
import CardHistoryPanel from './CardHistoryPanel.vue';
import CardRefLink from './CardRefLink.vue';
import StaleWarningRibbon from './StaleWarningRibbon.vue';
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
  currentPlanning: planning,
  currentDispatches: dispatches,
  currentDetailError,
  currentDetailFreshness,
  loading,
} = storeToRefs(cardStore);

const detailError = computed<DetailErrorState | null>(() => currentDetailError.value);
const detailFreshness = computed(() => currentDetailFreshness.value);

const liveHighlighted = ref(false);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

const TYPE_ICONS: Record<string, string> = { project: '(P)', goal: '(G)', architecture: '(A)', code: '(C)', test: '(T)', doc: '(D)', data: '(DA)', research: '(R)', ops: '(O)' };
function typeIcon(type: string): string { return TYPE_ICONS[type] || '(?)'; }
function fmtDate(ts: string): string { return ts ? formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute') : ''; }
function esc(text: string): string { return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function renderMarkdown(text: string): string { return esc(text).replace(/\n/g, '<br>'); }
function statusBadgeClass(status: CardStatus): string { return `status-${status}`; }
function statusExplainer(status: CardStatus): string {
  const map: Record<CardStatus, string> = {
    backlog: 'This card is planned but not started.',
    running: 'This card is running. Status records may be incomplete until the active work finishes.',
    blocked: 'This card is blocked. Check blockers, tool errors, review findings, and notes before retrying.',
    changed: 'This card has changed and needs planner attention before completion can proceed.',
    done: 'This card is marked done. Review status and review records before treating it as accepted.',
    failed: 'This card failed. Inspect error, status records, and agent/review context.',
    cancelled: 'This card was cancelled and should not be treated as completed work.',
    needs_verification: 'This card needs verification. Inspect status and review records before accepting or restarting.',
  };
  return map[status];
}

const completionLabel = computed(() => {
  return lifecycle.value?.completionState || 'unknown';
});
const childWorkSummary = computed(() => {
  if (!lifecycle.value) return 'No child summary available.';
  const counts = lifecycle.value.childCounts;
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return `${total} children: ${counts.running} running, ${counts.blocked + counts.failed} blocked/failed, ${counts.done} done`;
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
.detail-loading,.preview-empty { padding:16px; color:var(--text-muted); font-size:13px; }
.detail-section { margin-bottom:20px; padding-bottom:16px; border-bottom:1px solid var(--surface-3); }
.detail-section.live-highlight { border-color:var(--accent-2); box-shadow:0 0 0 1px rgba(31,111,235,.45), 0 0 16px rgba(31,111,235,.18); transition:box-shadow .2s ease, border-color .2s ease; }
.section-heading,.subheading { font-size:12px; font-weight:600; color:var(--text-muted); text-transform:uppercase; margin:0 0 10px 0; }
.header-section { padding-bottom:12px; }
.detail-title-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.detail-type-badge,.badge { font-size:12px; padding:2px 8px; border-radius:4px; background:var(--surface-3); border:1px solid var(--border); color:var(--text); }
.badge.subtle { color:var(--text-muted); }
.badge.success { color:var(--accent); }
.badge.warning { color:var(--warn); }
.badge.error { color:var(--danger); }
.detail-title { font-size:20px; font-weight:600; color:var(--text); margin:0; }
.detail-display-path { margin-right:8px; color:var(--accent-2); font-family:'SF Mono',monospace; font-size:18px; }
.detail-status-chip { font-size:11px; font-weight:600; padding:2px 10px; border-radius:10px; text-transform:uppercase; border:1px solid transparent; }
.status-running { background:var(--entry-user-bg); color:var(--accent-2); border-color:var(--accent-2); }
.status-done { background:var(--entry-accent-bg); color:var(--accent); border-color:var(--accent); }
.status-failed { background:var(--entry-danger-bg); color:var(--danger); border-color:var(--danger); }
.status-backlog,.status-cancelled,.status-blocked { background:var(--surface-3); color:var(--text); border-color:var(--border-strong); }
.status-needs_verification { background:var(--entry-warn-bg); color:var(--warn); border-color:var(--warn); }
.detail-id,.output-path { font-family:'SF Mono',monospace; }
.meta-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:8px; }
.meta-item { display:flex; flex-direction:column; gap:2px; }
.meta-key { font-size:11px; color:var(--text-muted); }
.meta-value { font-size:13px; color:var(--text); }
.notes-list,.children-list { display:flex; flex-direction:column; gap:8px; }
.note-item,.verification-row,.child-row { background:var(--surface-1); border:1px solid var(--surface-3); border-radius:6px; padding:10px 12px; }
.child-row { text-align:left; cursor:pointer; }
.child-card-main { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.child-card-title,.note-content,.evidence-summary,.planning-summary { color:var(--text-muted); font-size:12px; }
.detail-callout { padding:10px 12px; border-radius:6px; background:var(--entry-user-bg); color:var(--text); margin-bottom:8px; }
.detail-callout.warning { background:var(--entry-warn-bg); }
.detail-callout.error { background:var(--entry-danger-bg); }
.detail-callout.success { background:var(--entry-accent-bg); }

.retry-btn,.card-ref-button { padding:6px 10px; background:var(--surface-3); border:1px solid var(--border); color:var(--text); border-radius:4px; cursor:pointer; }
.empty-evidence { color:var(--text-muted); font-size:13px; padding:8px 0; }
.pill-list { display:flex; flex-wrap:wrap; gap:8px; }
.link-list-row,.list-block { margin-top:10px; }
.note-header { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
.discuss-btn {
  margin-left: auto;
  border: 1px solid var(--accent-2);
  background: var(--bg);
  color: var(--accent-2);
  border-radius: 999px;
  padding: 6px 10px;
  cursor: pointer;
}

.allowed-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.allowed-action { font-size: 11px; padding: 2px 6px; border-radius: 999px; background: var(--accent-2)22; color: var(--accent-2); border: 1px solid var(--accent-2)66; }
</style>
