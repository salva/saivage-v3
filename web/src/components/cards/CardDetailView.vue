<template>
  <div class="card-detail-container">
    <div v-if="loading" class="detail-loading">Loading card...</div>
    <div v-else-if="errorMsg" class="detail-error">{{ errorMsg }}</div>
    <template v-else-if="currentCard">
      <!-- Header -->
      <section class="detail-section header-section">
        <div class="detail-title-row">
          <span class="detail-type-badge" :class="'type-' + currentCard.type">
            {{ typeIcon(currentCard.type) }} {{ currentCard.type }}
          </span>
          <h1 class="detail-title">{{ currentCard.title }}</h1>
          <span class="detail-status-chip" :class="'status-' + currentCard.status">
            {{ currentCard.status }}
          </span>
        </div>
        <div class="detail-id">ID: {{ currentCard.id }}</div>
      </section>

      <!-- Description -->
      <section v-if="currentCard.description" class="detail-section">
        <h3 class="section-heading">Description</h3>
        <div class="detail-description" v-html="renderMarkdown(currentCard.description)"></div>
      </section>

      <!-- Metadata -->
      <section class="detail-section">
        <h3 class="section-heading">Metadata</h3>
        <div class="meta-grid">
          <div class="meta-item"><span class="meta-key">Created</span><span class="meta-value">{{ fmtDate(currentCard.created_at) }}</span></div>
          <div class="meta-item"><span class="meta-key">Updated</span><span class="meta-value">{{ fmtDate(currentCard.updated_at) }}</span></div>
          <div v-if="currentCard.started_at" class="meta-item"><span class="meta-key">Started</span><span class="meta-value">{{ fmtDate(currentCard.started_at) }}</span></div>
          <div v-if="currentCard.completed_at" class="meta-item"><span class="meta-key">Completed</span><span class="meta-value">{{ fmtDate(currentCard.completed_at) }}</span></div>
          <div class="meta-item"><span class="meta-key">Priority</span><span class="meta-value" :class="{ high: currentCard.priority > 5 }">{{ currentCard.priority }} / 10</span></div>
          <div class="meta-item"><span class="meta-key">Urgency</span><span class="meta-value">{{ currentCard.urgency }}</span></div>
          <div v-if="currentCard.created_by" class="meta-item"><span class="meta-key">Created By</span><span class="meta-value">{{ currentCard.created_by }}</span></div>
          <div v-if="currentCard.assigned_to" class="meta-item"><span class="meta-key">Assigned To</span><span class="meta-value">{{ currentCard.assigned_to }}</span></div>
          <div v-if="currentCard.estimate" class="meta-item"><span class="meta-key">Estimate</span><span class="meta-value">{{ currentCard.estimate }}</span></div>
          <div v-if="currentCard.duration_ms != null" class="meta-item"><span class="meta-key">Duration</span><span class="meta-value">{{ fmtDuration(currentCard.duration_ms) }}</span></div>
          <div v-if="currentCard.retries > 0" class="meta-item"><span class="meta-key">Retries</span><span class="meta-value retries">{{ currentCard.retries }}</span></div>
          <div class="meta-item"><span class="meta-key">Tags</span><span class="meta-value">
            <span v-if="currentCard.tags.length === 0" class="dim">none</span>
            <span v-else class="tags-list"><span v-for="tag in currentCard.tags" :key="tag" class="tag-pill">{{ tag }}</span></span>
          </span></div>
        </div>
      </section>

      <!-- Acceptance -->
      <section v-if="currentCard.acceptance" class="detail-section">
        <h3 class="section-heading">Acceptance Criteria</h3>
        <div class="detail-description" v-html="renderMarkdown(currentCard.acceptance)"></div>
      </section>

      <!-- Dependencies -->
      <section v-if="currentCard.depends_on.length || currentCard.blocks.length || currentCard.related.length" class="detail-section">
        <h3 class="section-heading">Dependencies</h3>
        <div class="dep-grid">
          <div v-if="currentCard.depends_on.length" class="dep-group">
            <span class="dep-label">Depends On</span>
            <span v-for="depId in currentCard.depends_on" :key="depId" class="dep-link" @click="navigateCard(depId)">{{ resolveTitle(depId) }} <span class="dep-id">({{ depId.slice(0,8) }})</span></span>
          </div>
          <div v-if="currentCard.blocks.length" class="dep-group">
            <span class="dep-label">Blocks</span>
            <span v-for="blockId in currentCard.blocks" :key="blockId" class="dep-link" @click="navigateCard(blockId)">{{ resolveTitle(blockId) }} <span class="dep-id">({{ blockId.slice(0,8) }})</span></span>
          </div>
          <div v-if="currentCard.related.length" class="dep-group">
            <span class="dep-label">Related</span>
            <span v-for="relId in currentCard.related" :key="relId" class="dep-link" @click="navigateCard(relId)">{{ resolveTitle(relId) }} <span class="dep-id">({{ relId.slice(0,8) }})</span></span>
          </div>
        </div>
      </section>

      <!-- Hierarchy -->
      <section v-if="currentCard.parent || children.length" class="detail-section">
        <h3 class="section-heading">Hierarchy</h3>
        <div class="hierarchy-info">
          <div v-if="currentCard.parent" class="hierarchy-item">
            <span class="hi-label">Parent</span>
            <span class="dep-link" @click="navigateCard(currentCard.parent!)">{{ resolveTitle(currentCard.parent) || currentCard.parent }}</span>
          </div>
          <div v-if="children.length" class="hierarchy-item">
            <span class="hi-label">Children ({{ children.length }})</span>
            <div class="children-list">
              <span v-for="child in children" :key="child.id" class="child-chip" @click="navigateCard(child.id)">
                <span class="child-type-icon">{{ typeIcon(child.type) }}</span>{{ child.title }}
                <span class="child-status-dot" :class="'status-' + child.status"></span>
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- Plan Diary -->
      <section v-if="currentCard.type === 'plan' && diaryEntries.length" class="detail-section">
        <h3 class="section-heading">Plan Diary</h3>
        <div class="diary-entries">
          <div v-for="entry in diaryEntries" :key="entry.id" class="diary-entry">
            <div class="diary-header">
              <span class="diary-kind" :class="'kind-' + entry.kind">{{ entry.kind }}</span>
              <span class="diary-time">{{ fmtDate(entry.timestamp) }}</span>
            </div>
            <div v-if="entry.input_summary" class="diary-summary"><strong>Input:</strong> {{ entry.input_summary }}</div>
            <div v-if="entry.decision" class="diary-decision"><strong>Decision:</strong> {{ entry.decision }}</div>
            <div v-if="entry.rationale" class="diary-rationale">{{ entry.rationale }}</div>
            <div v-if="entry.created_cards?.length" class="diary-cards">
              <span class="diary-label">Created:</span>
              <span v-for="cid in entry.created_cards" :key="cid" class="dep-link" @click="navigateCard(cid)">{{ cid.slice(0,8) }}</span>
            </div>
            <div v-if="entry.assessment" class="diary-assessment">
              <div class="assessment-header" :class="'result-' + entry.assessment.result">
                <span class="assessment-result">{{ entry.assessment.result === 'pass' ? 'PASS' : 'FAIL' }}</span>
                <span class="assessment-reviewer">{{ entry.assessment.reviewer_session_id.slice(0,8) }}</span>
              </div>
              <div class="assessment-summary">{{ entry.assessment.summary }}</div>
              <div v-if="entry.assessment.achieved.length" class="assessment-list achieved">
                <span class="al-label">Achieved:</span>
                <ul><li v-for="item in entry.assessment.achieved" :key="item">{{ item }}</li></ul>
              </div>
              <div v-if="entry.assessment.missing.length" class="assessment-list missing">
                <span class="al-label">Missing:</span>
                <ul><li v-for="item in entry.assessment.missing" :key="item">{{ item }}</li></ul>
              </div>
              <div v-if="entry.assessment.evidence_card_ids.length" class="assessment-evidence">
                <span class="al-label">Evidence:</span>
                <span v-for="eid in entry.assessment.evidence_card_ids" :key="eid" class="dep-link" @click="navigateCard(eid)">{{ eid.slice(0,8) }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Goal Summary -->
      <section v-if="currentCard.type === 'goal' && children.length" class="detail-section">
        <h3 class="section-heading">Goal Summary</h3>
        <div class="goal-summary">
          <div class="gs-stats">
            <span class="gs-stat done">{{ children.filter(c => c.status === 'done').length }} done</span>
            <span class="gs-stat active">{{ children.filter(c => c.status === 'active' || c.status === 'running').length }} active</span>
            <span class="gs-stat failed">{{ children.filter(c => c.status === 'failed').length }} failed</span>
            <span class="gs-stat total">{{ children.length }} total</span>
          </div>
          <div v-if="planCardId" class="gs-plan-link">
            <span class="dep-link" @click="navigateCard(planCardId)">View Plan Card</span>
          </div>
        </div>
      </section>

      <!-- Notes -->
      <section v-if="currentCard.notes && currentCard.notes.length" class="detail-section">
        <h3 class="section-heading">Notes & Activity</h3>
        <div class="notes-list">
          <div v-for="note in currentCard.notes" :key="note.id" class="note-item" :class="{ 'note-handled': note.handled }">
            <div class="note-header">
              <span class="note-author">{{ note.author }}</span>
              <span class="note-kind-badge">{{ note.kind }}</span>
              <span v-if="note.handled" class="note-handled-badge">handled</span>
              <span class="note-time">{{ fmtDate(note.timestamp) }}</span>
            </div>
            <div class="note-content" v-html="renderMarkdown(note.content)"></div>
          </div>
        </div>
      </section>

      <!-- Artifacts -->
      <section v-if="currentCard.artifacts.length" class="detail-section">
        <h3 class="section-heading">Artifacts</h3>
        <div class="artifact-list">
          <div v-for="art in currentCard.artifacts" :key="art.id" class="artifact-item">
            <span class="art-icon">{{ artIcon(art.type) }}</span>
            <span class="art-path">{{ art.path }}</span>
            <span class="art-type-badge">{{ art.type }}</span>
            <span v-if="art.retain" class="art-retain">retained</span>
            <span class="art-desc">{{ art.description }}</span>
          </div>
        </div>
      </section>

      <!-- Attachments -->
      <section v-if="currentCard.attachments.length" class="detail-section">
        <h3 class="section-heading">Attachments</h3>
        <div class="attachment-list">
          <div v-for="att in currentCard.attachments" :key="att.id" class="attachment-item">
            <span class="att-icon">*</span>
            <span class="att-title">{{ att.title }}</span>
            <span class="att-mime">{{ att.mime }}</span>
            <span class="att-path">{{ att.path }}</span>
          </div>
        </div>
      </section>

      <!-- Result -->
      <section v-if="currentCard.result" class="detail-section">
        <h3 class="section-heading">Result</h3>
        <pre class="detail-json">{{ fmtJson(currentCard.result) }}</pre>
      </section>

      <!-- Metrics -->
      <section v-if="currentCard.metrics && Object.keys(currentCard.metrics).length" class="detail-section">
        <h3 class="section-heading">Metrics</h3>
        <pre class="detail-json">{{ fmtJson(currentCard.metrics) }}</pre>
      </section>

      <!-- Error -->
      <section v-if="currentCard.error" class="detail-section">
        <h3 class="section-heading error-heading">Error</h3>
        <pre class="detail-error-block">{{ currentCard.error }}</pre>
      </section>

      <!-- Breadcrumb -->
      <section v-if="ancestorIds.length" class="detail-section">
        <h3 class="section-heading">Breadcrumb</h3>
        <div class="breadcrumb">
          <span v-for="(aid, idx) in ancestorIds" :key="aid">
            <span v-if="idx > 0" class="bc-sep">/</span>
            <span class="dep-link" @click="navigateCard(aid)">{{ resolveTitle(aid) || aid.slice(0,8) }}</span>
          </span>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useCardStore } from '../../stores/cards';
import { storeToRefs } from 'pinia';
import type { CardRecord, CardType, DiaryEntry } from '../../api/types';
import { createLogger } from '../../utils/logger';

const log = createLogger('comp:card-detail');

const props = defineProps<{ cardId: string }>();
const emit = defineEmits<{ navigate: [id: string] }>();

const cardStore = useCardStore();
const { currentCard, currentChildren: children, currentAncestorIds: ancestorIds, loading, error } = storeToRefs(cardStore);
const errorMsg = computed(() => error.value);

const TYPE_ICONS: Record<string, string> = {
  project: '(P)', goal: '(G)', plan: '(PL)', architecture: '(A)',
  code: '(C)', test: '(T)', doc: '(D)', data: '(DA)', research: '(R)', ops: '(O)',
};
function typeIcon(type: string): string { return TYPE_ICONS[type] || '(?)'; }
function artIcon(type: string): string {
  const m: Record<string, string> = { model: 'M', data: 'D', config: 'C', log: 'L', report: 'R', other: 'O' };
  return m[type] || '?';
}

const diaryEntries = computed<DiaryEntry[]>(() => {
  if (!currentCard.value || currentCard.value.type !== 'plan') return [];
  const raw = currentCard.value.result as Record<string, unknown> | null;
  if (raw && Array.isArray(raw.diary)) return raw.diary as DiaryEntry[];
  return [];
});

const planCardId = computed<string | null>(() => {
  if (currentCard.value?.type !== 'goal') return null;
  return children.value.find(c => c.type === 'plan')?.id || null;
});

function resolveTitle(id: string): string {
  return cardStore.cards.find(c => c.id === id)?.title || '';
}
function navigateCard(id: string): void { emit('navigate', id); }
function fmtDate(ts: string): string { try { return new Date(ts).toLocaleString(); } catch { return ts; } }
function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  return m + 'm ' + Math.round((ms % 60000) / 1000) + 's';
}
function fmtJson(obj: Record<string, unknown>): string {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}
function esc(text: string): string { return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function renderMarkdown(text: string): string {
  let out = esc(text);
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block"><code>$2</code></pre>');
  out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\n/g, '<br>');
  return out;
}

onMounted(async () => {
  try { await cardStore.fetchCardDetail(props.cardId); } catch (err) { log.error('fetch', err); }
});
watch(() => props.cardId, async (nid) => {
  if (nid) { try { await cardStore.fetchCardDetail(nid); } catch (err) { log.error('fetch', err); } }
});
</script>

<style scoped>
.card-detail-container { flex:1; overflow-y:auto; padding:20px; }
.detail-loading,.detail-error { padding:32px; text-align:center; color:#8b949e; font-size:13px; }
.detail-error { color:#f85149; }
.detail-section { margin-bottom:20px; padding-bottom:16px; border-bottom:1px solid #21262d; }
.detail-section:last-child { border-bottom:none; }
.section-heading { font-size:12px; font-weight:600; color:#8b949e; text-transform:uppercase; letter-spacing:0.04em; margin:0 0 10px 0; }
.section-heading.error-heading { color:#f85149; }
.header-section { padding-bottom:12px; }
.detail-title-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.detail-type-badge { font-size:12px; padding:2px 8px; border-radius:4px; background:#21262d; border:1px solid #30363d; color:#c9d1d9; text-transform:capitalize; }
.detail-title { font-size:20px; font-weight:600; color:#f0f6fc; margin:0; }
.detail-status-chip { font-size:11px; font-weight:600; padding:2px 10px; border-radius:10px; text-transform:uppercase; border:1px solid transparent; }
.status-drafting { background:#21262d; color:#8b949e; border-color:#484f58; }
.status-backlog { background:#21262d; color:#c9d1d9; border-color:#484f58; }
.status-active,.status-running { background:#1c2738; color:#58a6ff; border-color:#1f6feb; }
.status-blocked { background:#241f18; color:#d29922; border-color:#9e6a03; }
.status-done { background:#1a2418; color:#7ee787; border-color:#238636; }
.status-failed { background:#241818; color:#f85149; border-color:#da3633; }
.status-cancelled { background:#21262d; color:#484f58; border-color:#484f58; }
.detail-id { margin-top:6px; font-size:11px; color:#484f58; font-family:'SF Mono',monospace; }
.detail-description { font-size:13px; line-height:1.6; color:#c9d1d9; }
.detail-description :deep(.code-block) { background:#0d1117; border:1px solid #30363d; border-radius:4px; padding:10px 12px; margin:8px 0; overflow-x:auto; font-size:12px; font-family:'SF Mono',monospace; }
.detail-description :deep(.inline-code) { background:#21262d; padding:1px 5px; border-radius:3px; font-size:12px; font-family:'SF Mono',monospace; color:#d2a8ff; }
.detail-description :deep(strong) { color:#f0f6fc; }
.meta-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:8px; }
.meta-item { display:flex; flex-direction:column; gap:2px; }
.meta-key { font-size:11px; color:#8b949e; }
.meta-value { font-size:13px; color:#c9d1d9; }
.meta-value.dim { color:#484f58; }
.meta-value.high { color:#f85149; font-weight:600; }
.meta-value.retries { color:#d29922; }
.tags-list { display:flex; flex-wrap:wrap; gap:4px; }
.tag-pill { font-size:11px; padding:1px 7px; background:#1c2738; color:#58a6ff; border-radius:10px; border:1px solid #30363d; }
.dep-grid { display:flex; flex-direction:column; gap:8px; }
.dep-group { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.dep-label { font-size:12px; color:#8b949e; font-weight:500; }
.dep-link { font-size:12px; color:#58a6ff; cursor:pointer; padding:2px 6px; border-radius:4px; transition:background .15s; }
.dep-link:hover { background:#1c2738; }
.dep-id { font-size:10px; color:#484f58; font-family:'SF Mono',monospace; }
.hierarchy-info { display:flex; flex-direction:column; gap:10px; }
.hierarchy-item { display:flex; flex-direction:column; gap:4px; }
.hi-label { font-size:12px; color:#8b949e; font-weight:500; }
.children-list { display:flex; flex-wrap:wrap; gap:6px; }
.child-chip { display:inline-flex; align-items:center; gap:4px; padding:4px 10px; background:#161b22; border:1px solid #30363d; border-radius:6px; font-size:12px; color:#c9d1d9; cursor:pointer; transition:border-color .15s; }
.child-chip:hover { border-color:#58a6ff; }
.child-type-icon { font-size:13px; }
.child-status-dot { width:6px; height:6px; border-radius:50%; margin-left:2px; }
.child-status-dot.status-running { background:#3fb950; }
.child-status-dot.status-active { background:#58a6ff; }
.child-status-dot.status-blocked { background:#d29922; }
.child-status-dot.status-done { background:#7ee787; }
.child-status-dot.status-failed { background:#f85149; }
.child-status-dot.status-drafting,.child-status-dot.status-backlog,.child-status-dot.status-cancelled { background:#484f58; }
.diary-entries { display:flex; flex-direction:column; gap:10px; }
.diary-entry { background:#161b22; border:1px solid #21262d; border-radius:6px; padding:12px; }
.diary-header { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.diary-kind { font-size:11px; font-weight:600; padding:1px 8px; border-radius:8px; background:#21262d; color:#8b949e; text-transform:capitalize; }
.diary-kind.kind-planner_invocation { background:#1c2738; color:#58a6ff; }
.diary-kind.kind-planner_decision { background:#1a2418; color:#7ee787; }
.diary-kind.kind-card_mutation { background:#241f18; color:#d29922; }
.diary-kind.kind-review_assessment { background:#1a1824; color:#d2a8ff; }
.diary-kind.kind-failure_handling { background:#241818; color:#f85149; }
.diary-time { font-size:11px; color:#484f58; }
.diary-summary,.diary-decision,.diary-rationale { font-size:13px; color:#c9d1d9; line-height:1.5; margin-top:4px; }
.diary-cards { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-top:6px; }
.diary-label { font-size:11px; color:#8b949e; }
.diary-assessment { margin-top:8px; padding:10px; background:#0d1117; border:1px solid #21262d; border-radius:6px; }
.assessment-header { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.assessment-result { font-size:13px; font-weight:700; }
.result-pass { color:#7ee787; }
.result-fail { color:#f85149; }
.assessment-reviewer { font-size:11px; color:#484f58; font-family:'SF Mono',monospace; }
.assessment-summary { font-size:13px; color:#c9d1d9; line-height:1.5; }
.assessment-list { margin-top:6px; }
.al-label { font-size:11px; font-weight:600; color:#8b949e; }
.assessment-list ul { margin:4px 0 0 16px; padding:0; list-style:disc; }
.assessment-list li { font-size:12px; color:#c9d1d9; line-height:1.5; }
.assessment-list.achieved li { color:#7ee787; }
.assessment-list.missing li { color:#f85149; }
.assessment-evidence { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-top:6px; }
.goal-summary { display:flex; flex-direction:column; gap:8px; }
.gs-stats { display:flex; gap:12px; }
.gs-stat { font-size:13px; padding:3px 10px; border-radius:6px; background:#21262d; color:#c9d1d9; font-weight:500; }
.gs-stat.done { background:#1a2418; color:#7ee787; }
.gs-stat.active { background:#1c2738; color:#58a6ff; }
.gs-stat.failed { background:#241818; color:#f85149; }
.notes-list { display:flex; flex-direction:column; gap:8px; }
.note-item { background:#161b22; border:1px solid #21262d; border-radius:6px; padding:10px 12px; }
.note-item.note-handled { opacity:.7; }
.note-header { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
.note-author { font-size:11px; font-weight:600; color:#58a6ff; text-transform:capitalize; }
.note-kind-badge { font-size:10px; padding:1px 5px; border-radius:3px; background:#21262d; color:#8b949e; }
.note-handled-badge { font-size:10px; padding:1px 5px; border-radius:3px; background:#1a2418; color:#7ee787; }
.note-time { font-size:10px; color:#484f58; margin-left:auto; }
.note-content { font-size:12px; color:#c9d1d9; line-height:1.5; }
.artifact-list,.attachment-list { display:flex; flex-direction:column; gap:6px; }
.artifact-item,.attachment-item { display:flex; align-items:center; gap:8px; padding:6px 10px; background:#161b22; border:1px solid #21262d; border-radius:4px; font-size:12px; }
.art-icon,.att-icon { font-size:14px; flex-shrink:0; }
.art-path,.att-path { font-family:'SF Mono',monospace; font-size:11px; color:#8b949e; }
.art-type-badge,.att-mime { font-size:10px; padding:1px 5px; background:#21262d; border-radius:3px; color:#8b949e; }
.art-retain { font-size:10px; padding:1px 5px; background:#1a2418; border-radius:3px; color:#7ee787; }
.art-desc,.att-title { color:#c9d1d9; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.detail-json,.detail-error-block { background:#0d1117; border:1px solid #21262d; border-radius:4px; padding:12px; font-size:12px; font-family:'SF Mono',monospace; line-height:1.5; overflow-x:auto; white-space:pre-wrap; word-break:break-word; color:#c9d1d9; margin:0; }
.detail-error-block { border-color:#da3633; color:#f85149; background:#241818; }
.breadcrumb { display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
.bc-sep { color:#484f58; font-size:12px; }
</style>
