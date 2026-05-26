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
          <h1 class="detail-title">{{ currentCard.title }}</h1>
          <span class="detail-status-chip" :class="'status-' + currentCard.status">{{ currentCard.status }}</span>
          <button type="button" class="discuss-btn" aria-label="Seed analyst chat with this card" @click="seedAnalystForCard">Discuss with analyst</button>
        </div>
        <div class="detail-id">ID: {{ currentCard.id }}</div>
        <div class="detail-callout" role="status">{{ lifecycle?.explanation || statusExplainer(currentCard.status) }}</div>
        <div v-if="detailFreshness.isStale" class="detail-callout warning" role="status">
          This card detail may be stale. Refresh to reload canonical card and evidence data from the server.
          <button type="button" class="retry-btn" @click="reloadDetail">Refresh card</button>
        </div>
        <StaleWarningRibbon :card-id="currentCard.id" />
        <div v-if="lifecycle?.error || currentCard.error" class="detail-callout error" role="alert">
          Card error: {{ lifecycle?.error || currentCard.error }}
        </div>
      </section>

      <section v-if="currentCard.allowedActions?.length" class="detail-section">
        <h3 class="section-heading">Allowed actions</h3>
        <div class="allowed-actions" data-testid="allowed-actions">
          <span v-for="action in currentCard.allowedActions" :key="action" class="allowed-action">{{ actionLabel(action) }}</span>
        </div>
      </section>

      <section v-if="currentCard.description" class="detail-section">
        <h3 class="section-heading">Description</h3>
        <div class="detail-description" v-html="renderMarkdown(currentCard.description)"></div>
      </section>

      <section class="detail-section">
        <h3 class="section-heading">Metadata</h3>
        <div class="meta-grid">
          <div class="meta-item"><span class="meta-key">Created</span><span class="meta-value" :title="timestampTitle(currentCard.created_at)">{{ fmtDate(currentCard.created_at) }}</span></div>
          <div class="meta-item"><span class="meta-key">Updated</span><span class="meta-value" :title="timestampTitle(currentCard.updated_at)">{{ fmtDate(currentCard.updated_at) }}</span></div>
          <div class="meta-item"><span class="meta-key">Version</span><span class="meta-value">{{ currentCard.version_seq ?? 'unknown' }}</span></div>
          <div v-if="currentCard.started_at || lifecycle?.startedAt" class="meta-item"><span class="meta-key">Started</span><span class="meta-value" :title="timestampTitle(currentCard.started_at || lifecycle?.startedAt || '')">{{ fmtDate(currentCard.started_at || lifecycle?.startedAt || '') }}</span></div>
          <div v-if="currentCard.completed_at || lifecycle?.completedAt" class="meta-item"><span class="meta-key">Completed</span><span class="meta-value" :title="timestampTitle(currentCard.completed_at || lifecycle?.completedAt || '')">{{ fmtDate(currentCard.completed_at || lifecycle?.completedAt || '') }}</span></div>
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
          <div class="meta-item"><span class="meta-key">Evidence readiness</span><span class="meta-value">{{ hasRecordedEvidence ? evidence?.summary.summary : 'No evidence summary returned.' }}</span></div>
          <div class="meta-item"><span class="meta-key">Child work</span><span class="meta-value">{{ childWorkSummary }}</span></div>
        </div>
        <div v-if="currentCard.depends_on.length" class="link-list-row">
          <span class="meta-key">Blocking dependencies</span>
          <div class="pill-list">
            <button v-for="depId in currentCard.depends_on" :key="depId" type="button" class="nav-pill" @click="navigateCard(depId)">{{ depId }}</button>
          </div>
        </div>
        <div v-if="currentCard.blocks.length" class="link-list-row">
          <span class="meta-key">Cards blocked by this card</span>
          <div class="pill-list">
            <button v-for="blockId in currentCard.blocks" :key="blockId" type="button" class="nav-pill" @click="navigateCard(blockId)">{{ blockId }}</button>
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
        <div v-if="currentAncestorIds.length" class="link-list-row">
          <span class="meta-key">Ancestors</span>
          <div class="pill-list">
            <button v-for="ancestorId in currentAncestorIds" :key="ancestorId" type="button" class="nav-pill" @click="navigateCard(ancestorId)">{{ ancestorId }}</button>
          </div>
        </div>
        <div v-if="currentChildren.length" class="children-list">
          <button v-for="child in currentChildren" :key="child.id" type="button" class="child-row" @click="navigateCard(child.id)">
            <span class="generated-file-main">
              <span class="generated-file-path">{{ child.id }}</span>
              <span class="badge">{{ child.type }}</span>
              <span class="badge" :class="statusBadgeClass(child.status)">{{ child.status }}</span>
            </span>
            <span class="generated-file-description">{{ child.title }}</span>
          </button>
        </div>
        <div v-else class="empty-evidence">No child cards are recorded for this card.</div>
      </section>

      <section class="detail-section">
        <h3 class="section-heading">Evidence &amp; generated files</h3>
        <div v-if="!hasRecordedEvidence" class="empty-evidence">No evidence has been recorded for this card.</div>
        <template v-else>
        <div class="evidence-summary">{{ evidenceSummaryLine }}</div>

        <div class="pill-list summary-pills">
          <span class="badge">Files: {{ generatedFiles.length }}</span>
          <span class="badge">Checks: {{ verificationCommands.length }}</span>
          <span class="badge">Tool errors: {{ evidence?.toolErrors.length || 0 }}</span>
          <span v-if="evidence?.summary.missingCount" class="badge warning">Missing files: {{ evidence.summary.missingCount }}</span>
          <span v-if="evidence?.summary.blockedCount" class="badge error">Blocked: {{ evidence.summary.blockedCount }}</span>
          <span v-if="evidence?.summary.redactedCount" class="badge warning">Redacted: {{ evidence.summary.redactedCount }}</span>
          <span v-if="evidence?.summary.parseRecovered" class="badge warning">Parse recovery</span>
        </div>

        <div v-if="evidence?.parseFailure" class="preview-notice warning">Executor final response was malformed; generated files and verification evidence were recovered from tool activity.</div>
        <div v-if="evidence?.toolErrors?.length" class="preview-notice error">
          <strong>Tool Errors</strong>
          <ul><li v-for="err in evidence.toolErrors" :key="err">{{ err }}</li></ul>
        </div>

        <div v-if="generatedFiles.length" class="generated-files-list">
          <button
            v-for="file in generatedFiles"
            :key="file.path"
            type="button"
            class="generated-file-row"
            :class="{ selected: selectedPath === file.path, disabled: isPreviewDisabled(file) }"
            :aria-label="`Preview generated file ${file.path}, ${fileStateLabel(file)}`"
            @click="openPreviewForFile(file)"
          >
            <span class="generated-file-main">
              <span class="generated-file-path">{{ file.path }}</span>
              <span class="badge">{{ sourceLabel(file.source) }}</span>
              <span v-if="file.artifactType" class="badge subtle">{{ file.artifactType }}</span>
              <span v-if="file.retain" class="badge success">retained</span>
              <span v-if="file.exists === false && !file.blocked" class="badge warning">missing</span>
              <span v-if="file.blocked" class="badge error">blocked</span>
              <span v-else-if="file.redactedOnly" class="badge warning">redacted</span>
              <span v-else-if="file.previewable === false" class="badge subtle">non-previewable</span>
            </span>
            <span v-if="file.description" class="generated-file-description">{{ file.description }}</span>
            <span v-if="file.availabilityReason" class="generated-file-description">{{ file.availabilityReason }}</span>
          </button>
        </div>

        <div v-if="generatedFiles.length || previewState.status !== 'idle'" class="preview-panel" aria-live="polite">
          <div v-if="previewState.status === 'idle'" class="preview-empty">Select a generated file to preview safe text content.</div>
          <div v-else-if="previewState.status === 'loading'" class="preview-empty">Loading preview…</div>
          <template v-else-if="previewState.status === 'ready'">
            <div class="preview-header">
              <span class="generated-file-path">{{ previewState.path }}</span>
              <span>{{ previewState.size }} bytes</span>
              <span>{{ previewState.contentType }}</span>
            </div>
            <div v-if="previewState.redactedHint" class="preview-notice">Sensitive values are redacted by the server.</div>
            <CodeBlock
              :code="previewState.content"
              language="text"
              copyable
              wrap
              :aria-label="`Read-only preview of ${previewState.path}`"
            />
          </template>
          <template v-else>
            <div class="preview-error-state">
              <div class="preview-notice error">{{ previewState.message }}</div>
              <button v-if="previewState.status !== 'blocked'" type="button" class="retry-btn" @click="openPreview(previewState.path, true)">Retry</button>
            </div>
          </template>
        </div>

        <div class="verification-section">
          <h4 class="subheading">Verification Commands</h4>
          <div v-if="verificationCommands.length" v-for="command in verificationCommands" :key="`${command.command}-${command.process_id}`" class="verification-row">
            <code class="inline-token generated-file-path">{{ command.command }}</code>
            <span class="badge">{{ command.status || 'unknown' }}</span>
            <span class="badge" :class="command.exit_code === 0 ? 'success' : command.exit_code == null ? 'subtle' : 'error'">{{ verificationOutcome(command) }}</span>
            <span v-if="command.timed_out" class="badge warning">timed out</span>
            <span v-if="command.process_id" class="badge subtle">process {{ command.process_id }}</span>
          </div>
          <div v-else class="empty-evidence">No verification commands were recorded for this card.</div>
        </div>
        </template>
      </section>

      <section class="detail-section">
        <h3 class="section-heading">Review result</h3>
        <div class="detail-callout" :class="reviewCalloutClass">
          <strong>{{ reviewTitle }}</strong>
          <div>{{ review?.summary || 'No review result was returned by the card detail API.' }}</div>
        </div>
        <template v-if="review?.review">
          <div v-if="review.review.achieved.length" class="list-block">
            <div class="meta-key">Achieved</div>
            <ul><li v-for="item in review.review.achieved" :key="item">{{ item }}</li></ul>
          </div>
          <div class="list-block">
            <div class="meta-key">Missing</div>
            <ul v-if="review.review.missing.length"><li v-for="item in review.review.missing" :key="item">{{ item }}</li></ul>
            <div v-else class="empty-evidence">No missing items recorded.</div>
          </div>
          <div v-if="review.review.evidence_card_ids.length" class="link-list-row">
            <span class="meta-key">Evidence cards</span>
            <div class="pill-list">
              <button v-for="evidenceId in review.review.evidence_card_ids" :key="evidenceId" type="button" class="nav-pill" @click="navigateCard(evidenceId)">{{ evidenceId }}</button>
            </div>
          </div>
        </template>
      </section>

      <section class="detail-section" v-if="dispatches && (dispatches.outgoing.length || dispatches.incoming.length)">
        <h3 class="section-heading">Dispatch summary</h3>
        <div v-if="dispatches.outgoing.length" class="list-block">
          <div class="meta-key">Outgoing dispatches</div>
          <div v-for="dispatch in dispatches.outgoing" :key="dispatch.dispatchId" class="verification-row">
            <button type="button" class="nav-pill" @click="navigateCard(dispatch.targetCardId)">{{ dispatch.targetCardId }}</button>
            <span class="badge">{{ dispatch.status }}</span>
            <span v-if="dispatch.outcome" class="badge subtle">{{ dispatch.outcome }}</span>
            <span>{{ dispatch.summary || 'No completion summary recorded.' }}</span>
          </div>
        </div>
        <div v-if="dispatches.incoming.length" class="list-block">
          <div class="meta-key">Incoming dispatches</div>
          <div v-for="dispatch in dispatches.incoming" :key="dispatch.dispatchId" class="verification-row">
            <button type="button" class="nav-pill" @click="navigateCard(dispatch.parentCardId)">{{ dispatch.parentCardId }}</button>
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

      <section v-if="currentCard.result" class="detail-section">
        <h3 class="section-heading">Result</h3>
        <CodeBlock :code="formatJson(currentCard.result)" language="json" copyable />
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useAnalystChat } from '../../stores/analystChat';
import { useCardStore } from '../../stores/cards';
import { useWsStore } from '../../stores/ws';
import { storeToRefs } from 'pinia';
import { getFileContent, ApiError } from '../../api/client';
import type { GeneratedFileRef, VerificationCommandRef, DetailErrorState, CardStatus, WsEnvelope } from '../../api/types';
import { createLogger } from '../../utils/logger';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../../utils/timestamp';
import CardHistoryPanel from './CardHistoryPanel.vue';
import StaleWarningRibbon from './StaleWarningRibbon.vue';
import CodeBlock from '../code/CodeBlock.vue';
import { formatJson } from '../../utils/format-json';

const log = createLogger('comp:card-detail');
const props = defineProps<{ cardId: string }>();
const emit = defineEmits<{ navigate: [id: string] }>();
const cardStore = useCardStore();
const analystChat = useAnalystChat();
const wsStore = useWsStore();
const {
  currentCard,
  currentChildren,
  currentAncestorIds,
  currentEvidence: evidence,
  currentLifecycle: lifecycle,
  currentReview: review,
  currentPlanning: planning,
  currentDispatches: dispatches,
  currentDetailError,
  currentDetailFreshness,
  loading,
  cardHistorySelectedSeq,
} = storeToRefs(cardStore);

const detailError = computed<DetailErrorState | null>(() => currentDetailError.value);
const detailFreshness = computed(() => currentDetailFreshness.value);

const selectedPath = ref<string | null>(null);
const liveHighlighted = ref(false);
const previewState = ref<{ status: 'idle' } | { status: 'loading'; path: string } | { status: 'ready'; path: string; size: number; contentType: string; content: string; redactedHint: boolean } | { status: 'missing' | 'blocked' | 'directory' | 'too_large' | 'binary' | 'error'; path: string; message: string }>({ status: 'idle' });
let wsUnsubscribe: (() => void) | null = null;
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTicket = 0;

const TYPE_ICONS: Record<string, string> = { project: '(P)', goal: '(G)', architecture: '(A)', code: '(C)', test: '(T)', doc: '(D)', data: '(DA)', research: '(R)', ops: '(O)' };
function typeIcon(type: string): string { return TYPE_ICONS[type] || '(?)'; }
function fmtDate(ts: string): string { return ts ? formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute') : ''; }
function esc(text: string): string { return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function renderMarkdown(text: string): string { return esc(text).replace(/\n/g, '<br>'); }
function sourceLabel(source: string): string { return source.replace('result.', ''); }
function statusBadgeClass(status: CardStatus): string { return `status-${status}`; }
function statusExplainer(status: CardStatus): string {
  const map: Record<CardStatus, string> = {
    drafting: 'This card is still being shaped and may not be dispatchable.',
    backlog: 'This card is planned but not started.',
    active: 'This card is active but not necessarily executing now.',
    running: 'This card is running. Evidence may be incomplete until the active work finishes.',
    blocked: 'This card is blocked. Check blockers, tool errors, review findings, and notes before retrying.',
    changed: 'This card has changed and needs planner attention before completion can proceed.',
    done: 'This card is marked done. Review evidence and verification below before treating it as accepted.',
    failed: 'This card failed. Inspect error, tool errors, verification commands, and agent/review context.',
    cancelled: 'This card was cancelled and should not be treated as completed work.',
    needs_verification: 'Executor preserved partial evidence via fallback. Verify artifacts and verification commands before accepting or restarting.',
  };
  return map[status];
}

const generatedFiles = computed<GeneratedFileRef[]>(() => evidence.value?.generatedFiles ?? []);
const verificationCommands = computed<VerificationCommandRef[]>(() => evidence.value?.verificationCommands ?? []);
const hasRecordedEvidence = computed(() => Boolean(
  evidence.value?.summary.hasRecordedEvidence
  || generatedFiles.value.length
  || verificationCommands.value.length
  || evidence.value?.toolErrors.length,
));
const completionLabel = computed(() => {
  if (review.value?.status === 'passed') return 'Review passed';
  if (review.value?.status === 'failed') return 'Review failed';
  if (evidence.value?.summary.state === 'incomplete') return 'Evidence incomplete';
  return lifecycle.value?.completionState || 'unknown';
});
const childWorkSummary = computed(() => {
  if (!lifecycle.value) return 'No child summary available.';
  const counts = lifecycle.value.childCounts;
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return `${total} children: ${counts.active + counts.running} active/running, ${counts.blocked + counts.failed} blocked/failed, ${counts.done} done`;
});
const evidenceSummaryLine = computed(() => evidence.value?.summary.summary || 'Evidence has been recorded for this card.');
const detailErrorTitle = computed(() => {
  switch (detailError.value?.kind) {
    case 'unauthorized': return 'Unauthorized';
    case 'not-found': return 'Card not found';
    case 'server': return 'Card detail unavailable';
    case 'network': return 'Network error';
    default: return 'Card detail error';
  }
});
const reviewTitle = computed(() => {
  switch (review.value?.status) {
    case 'passed': return 'Review passed';
    case 'failed': return 'Review failed';
    case 'incomplete': return 'Review incomplete';
    default: return 'Not reviewed';
  }
});
const reviewCalloutClass = computed(() => review.value?.status === 'passed' ? 'success' : review.value?.status === 'failed' ? 'error' : 'warning');

function verificationOutcome(command: VerificationCommandRef): string {
  if (command.timed_out) return 'timed out';
  if (command.exit_code === 0) return 'pass';
  if (command.exit_code == null) return 'unknown exit';
  return `fail (${command.exit_code})`;
}

function fileStateLabel(file: GeneratedFileRef): string {
  if (file.blocked) return 'blocked';
  if (file.exists === false) return 'missing';
  if (file.redactedOnly) return 'redacted';
  if (file.previewable === false) return 'non-previewable';
  return 'available';
}

function isPreviewDisabled(file: GeneratedFileRef): boolean {
  return file.blocked === true || file.previewable === false;
}

async function openPreview(path: string, force = false): Promise<void> {
  if (!force && previewState.value.status === 'ready' && previewState.value.path === path) return;
  selectedPath.value = path;
  previewState.value = { status: 'loading', path };
  try {
    const response = await getFileContent(path);
    const redactedHint = response.redacted === true || response.sensitivity === 'sensitive-redacted';
    previewState.value = { status: 'ready', path: response.path, size: response.size, contentType: response.contentType, content: response.content, redactedHint };
  } catch (err) {
    const apiErr = err as ApiError;
    let status: 'missing' | 'blocked' | 'directory' | 'too_large' | 'binary' | 'error' = 'error';
    let message = 'Could not load preview. Refresh the card and retry; use Debug if the error persists.';
    if (apiErr?.status === 404) { status = 'missing'; message = 'File was recorded as evidence but is no longer present in the workspace.'; }
    else if (apiErr?.status === 403) { status = 'blocked'; message = 'Preview blocked by file-access security. Use controlled maintenance procedures before direct inspection.'; }
    else if (apiErr?.status === 400) { status = 'directory'; message = 'This evidence path points to a directory, not a previewable file.'; }
    else if (apiErr?.status === 413) { status = 'too_large'; message = 'File is too large to preview in the control room.'; }
    else if (apiErr?.status === 415) { status = 'binary'; message = 'Binary or non-text file cannot be previewed here.'; }
    else if (apiErr instanceof Error && apiErr.message) { message = apiErr.message; }
    previewState.value = { status, path, message };
  }
}

function openPreviewForFile(file: GeneratedFileRef): void {
  selectedPath.value = file.path;
  if (isPreviewDisabled(file)) {
    previewState.value = {
      status: 'blocked',
      path: file.path,
      message: file.blocked
        ? (file.availabilityReason || 'Preview blocked by file-access security. Use controlled maintenance procedures before direct inspection.')
        : 'This evidence is classified as non-previewable by the server.',
    };
    return;
  }
  void openPreview(file.path);
}

function navigateCard(id: string): void { emit('navigate', id); }
async function reloadDetail(): Promise<void> { try { await cardStore.fetchCardDetail(props.cardId); } catch (err) { log.error('fetch', err); } }

function clearHighlightTimer(): void {
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
}

function pulseHighlight(): void {
  clearHighlightTimer();
  liveHighlighted.value = true;
  highlightTimer = setTimeout(() => {
    liveHighlighted.value = false;
    highlightTimer = null;
  }, 1800);
}

async function softRefreshForCard(cardId: string): Promise<void> {
  const ticket = ++refreshTicket;
  const selectedSeq = cardHistorySelectedSeq.value;
  pulseHighlight();
  await Promise.allSettled([
    cardStore.fetchCardDetail(cardId),
    cardStore.fetchCardHistoryForCard(cardId),
  ]);
  if (refreshTicket !== ticket) return;
  if (selectedSeq != null) {
    const historyStillContainsSelection = cardStore.cardHistory.some((entry) => entry.version_seq === selectedSeq);
    if (historyStillContainsSelection) {
      await cardStore.selectCardHistoryVersion(cardId, selectedSeq).catch(() => {});
    }
  }
}

function isMatchingCardActivity(envelope: WsEnvelope): boolean {
  const content = envelope.content || {};
  const event = typeof content.event === 'string' ? content.event : null;
  if (event === 'card_history_appended') {
    return content.card_id === props.cardId;
  }
  if (event === 'analyst_tool_invoked') {
    return content.related_card_id === props.cardId;
  }
  return false;
}

function subscribeToActivity(): void {
  wsUnsubscribe?.();
  wsUnsubscribe = wsStore.onType('activity', (envelope) => {
    if (!isMatchingCardActivity(envelope)) return;
    void softRefreshForCard(props.cardId).catch((err) => log.error('soft refresh failed', err));
  });
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
  subscribeToActivity();
  await reloadDetail();
});

onBeforeUnmount(() => {
  wsUnsubscribe?.();
  wsUnsubscribe = null;
  clearHighlightTimer();
});

watch(() => props.cardId, async (nid, oldId) => {
  if (oldId !== undefined) {
    wsUnsubscribe?.();
  }
  subscribeToActivity();
  liveHighlighted.value = false;
  clearHighlightTimer();
  selectedPath.value = null;
  previewState.value = { status: 'idle' };
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
.detail-status-chip { font-size:11px; font-weight:600; padding:2px 10px; border-radius:10px; text-transform:uppercase; border:1px solid transparent; }
.status-active,.status-running { background:var(--entry-user-bg); color:var(--accent-2); border-color:var(--accent-2); }
.status-done { background:var(--entry-accent-bg); color:var(--accent); border-color:var(--accent); }
.status-failed { background:var(--entry-danger-bg); color:var(--danger); border-color:var(--danger); }
.status-backlog,.status-drafting,.status-cancelled,.status-blocked { background:var(--surface-3); color:var(--text); border-color:var(--border-strong); }
.status-needs_verification { background:var(--entry-warn-bg); color:var(--warn); border-color:var(--warn); }
.detail-id,.generated-file-path { font-family:'SF Mono',monospace; }
.meta-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:8px; }
.meta-item { display:flex; flex-direction:column; gap:2px; }
.meta-key { font-size:11px; color:var(--text-muted); }
.meta-value { font-size:13px; color:var(--text); }
.notes-list,.generated-files-list,.children-list { display:flex; flex-direction:column; gap:8px; }
.note-item,.generated-file-row,.verification-row,.child-row { background:var(--surface-1); border:1px solid var(--surface-3); border-radius:6px; padding:10px 12px; }
.generated-file-row,.child-row { text-align:left; cursor:pointer; }
.generated-file-row.selected { border-color:var(--accent-2); }
.generated-file-row.disabled { opacity:.9; }
.generated-file-main { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.generated-file-description,.note-content,.evidence-summary,.planning-summary { color:var(--text-muted); font-size:12px; }
.preview-panel { margin-top:12px; }
.preview-header { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:8px; color:var(--text-muted); font-size:12px; }
.preview-notice,.detail-callout { padding:10px 12px; border-radius:6px; background:var(--entry-user-bg); color:var(--text); margin-bottom:8px; }
.preview-notice.warning,.detail-callout.warning { background:var(--entry-warn-bg); }
.preview-notice.error,.detail-callout.error { background:var(--entry-danger-bg); }
.detail-callout.success { background:var(--entry-accent-bg); }

.retry-btn,.nav-pill { padding:6px 10px; background:var(--surface-3); border:1px solid var(--border); color:var(--text); border-radius:4px; cursor:pointer; }
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
