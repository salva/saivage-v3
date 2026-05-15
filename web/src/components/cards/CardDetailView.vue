<template>
  <div class="card-detail-container">
    <div v-if="loading" class="detail-loading">Loading card...</div>
    <div v-else-if="errorMsg" class="detail-error">{{ errorMsg }}</div>
    <template v-else-if="currentCard">
      <section class="detail-section header-section">
        <div class="detail-title-row">
          <span class="detail-type-badge" :class="'type-' + currentCard.type">{{ typeIcon(currentCard.type) }} {{ currentCard.type }}</span>
          <h1 class="detail-title">{{ currentCard.title }}</h1>
          <span class="detail-status-chip" :class="'status-' + currentCard.status">{{ currentCard.status }}</span>
        </div>
        <div class="detail-id">ID: {{ currentCard.id }}</div>
      </section>

      <section v-if="currentCard.description" class="detail-section">
        <h3 class="section-heading">Description</h3>
        <div class="detail-description" v-html="renderMarkdown(currentCard.description)"></div>
      </section>

      <section class="detail-section">
        <h3 class="section-heading">Metadata</h3>
        <div class="meta-grid">
          <div class="meta-item"><span class="meta-key">Created</span><span class="meta-value">{{ fmtDate(currentCard.created_at) }}</span></div>
          <div class="meta-item"><span class="meta-key">Updated</span><span class="meta-value">{{ fmtDate(currentCard.updated_at) }}</span></div>
          <div v-if="currentCard.started_at" class="meta-item"><span class="meta-key">Started</span><span class="meta-value">{{ fmtDate(currentCard.started_at) }}</span></div>
          <div v-if="currentCard.completed_at" class="meta-item"><span class="meta-key">Completed</span><span class="meta-value">{{ fmtDate(currentCard.completed_at) }}</span></div>
          <div class="meta-item"><span class="meta-key">Priority</span><span class="meta-value" :class="{ high: currentCard.priority > 5 }">{{ currentCard.priority }} / 10</span></div>
          <div class="meta-item"><span class="meta-key">Urgency</span><span class="meta-value">{{ currentCard.urgency }}</span></div>
        </div>
      </section>

      <section v-if="currentCard.notes && currentCard.notes.length" class="detail-section">
        <h3 class="section-heading">Notes & Activity</h3>
        <div class="notes-list">
          <div v-for="note in currentCard.notes" :key="note.id" class="note-item" :class="{ 'note-handled': note.handled }">
            <div class="note-header">
              <span class="note-author">{{ note.author }}</span>
              <span class="note-kind-badge">{{ note.kind }}</span>
              <span class="note-time">{{ fmtDate(note.timestamp) }}</span>
            </div>
            <div class="note-content" v-html="renderMarkdown(note.content)"></div>
          </div>
        </div>
      </section>

      <section v-if="hasEvidenceSection" class="detail-section">
        <h3 class="section-heading">Generated Files &amp; Evidence</h3>
        <div class="evidence-summary">{{ generatedFiles.length }} files, {{ verificationCommands.length }} checks</div>

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
            :class="{ selected: selectedPath === file.path }"
            :aria-label="`Preview generated file ${file.path}`"
            @click="openPreview(file.path)"
          >
            <span class="generated-file-main">
              <span class="generated-file-path">{{ file.path }}</span>
              <span class="badge">{{ sourceLabel(file.source) }}</span>
              <span v-if="file.artifactType" class="badge subtle">{{ file.artifactType }}</span>
              <span v-if="file.retain" class="badge success">retained</span>
              <span v-if="file.exists === false" class="badge warning">missing</span>
            </span>
            <span v-if="file.description" class="generated-file-description">{{ file.description }}</span>
          </button>
        </div>
        <div v-else class="empty-evidence">No generated files were recorded for this card.</div>

        <div class="preview-panel" aria-live="polite">
          <div v-if="previewState.status === 'idle'" class="preview-empty">Select a generated file to preview it.</div>
          <div v-else-if="previewState.status === 'loading'" class="preview-empty">Loading preview…</div>
          <template v-else-if="previewState.status === 'ready'">
            <div class="preview-header">
              <span class="generated-file-path">{{ previewState.path }}</span>
              <span>{{ previewState.size }} bytes</span>
              <span>{{ previewState.contentType }}</span>
            </div>
            <div v-if="previewState.redactedHint" class="preview-notice">Sensitive values are redacted by the server.</div>
            <pre class="detail-json preview-content" :aria-label="`Read-only preview of ${previewState.path}`"><code>{{ previewState.content }}</code></pre>
          </template>
          <template v-else>
            <div class="preview-error-state">
              <div class="preview-notice error">{{ previewState.message }}</div>
              <button type="button" class="retry-btn" @click="openPreview(previewState.path, true)">Retry</button>
            </div>
          </template>
        </div>

        <div v-if="verificationCommands.length" class="verification-section">
          <h4 class="subheading">Verification Commands</h4>
          <div v-for="command in verificationCommands" :key="`${command.command}-${command.process_id}`" class="verification-row">
            <code class="generated-file-path">{{ command.command }}</code>
            <span class="badge">{{ command.status || 'unknown' }}</span>
            <span class="badge" :class="command.exit_code === 0 ? 'success' : command.exit_code == null ? 'subtle' : 'error'">exit {{ command.exit_code ?? '?' }}</span>
            <span v-if="command.timed_out" class="badge warning">timed out</span>
            <span v-if="command.process_id" class="badge subtle">{{ command.process_id }}</span>
          </div>
        </div>
      </section>

      <section v-if="currentCard.result" class="detail-section">
        <h3 class="section-heading">Result</h3>
        <pre class="detail-json">{{ fmtJson(currentCard.result) }}</pre>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useCardStore } from '../../stores/cards';
import { storeToRefs } from 'pinia';
import { getFileContent, ApiError } from '../../api/client';
import type { DiaryEntry, GeneratedFileRef, VerificationCommandRef } from '../../api/types';
import { createLogger } from '../../utils/logger';

const log = createLogger('comp:card-detail');
const props = defineProps<{ cardId: string }>();
const emit = defineEmits<{ navigate: [id: string] }>();
const cardStore = useCardStore();
const { currentCard, currentChildren: children, currentAncestorIds: ancestorIds, currentEvidence: evidence, loading, error } = storeToRefs(cardStore);
const errorMsg = computed(() => error.value);

const selectedPath = ref<string | null>(null);
const previewState = ref<{ status: 'idle' } | { status: 'loading'; path: string } | { status: 'ready'; path: string; size: number; contentType: string; content: string; redactedHint: boolean } | { status: 'missing' | 'blocked' | 'directory' | 'too_large' | 'binary' | 'error'; path: string; message: string }>({ status: 'idle' });

const TYPE_ICONS: Record<string, string> = { project: '(P)', goal: '(G)', architecture: '(A)', code: '(C)', test: '(T)', doc: '(D)', data: '(DA)', research: '(R)', ops: '(O)' };
function typeIcon(type: string): string { return TYPE_ICONS[type] || '(?)'; }
function fmtDate(ts: string): string { try { return new Date(ts).toLocaleString(); } catch { return ts; } }
function fmtJson(obj: Record<string, unknown>): string { try { return JSON.stringify(obj, null, 2); } catch { return String(obj); } }
function esc(text: string): string { return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function renderMarkdown(text: string): string { return esc(text).replace(/\n/g, '<br>'); }
function sourceLabel(source: string): string { return source.replace('result.', ''); }

const generatedFiles = computed<GeneratedFileRef[]>(() => evidence.value?.generatedFiles ?? []);
const verificationCommands = computed<VerificationCommandRef[]>(() => evidence.value?.verificationCommands ?? []);
const hasEvidenceSection = computed(() => generatedFiles.value.length > 0 || verificationCommands.value.length > 0 || !!evidence.value?.parseFailure || !!evidence.value?.toolErrors?.length);

async function openPreview(path: string, force = false): Promise<void> {
  if (!force && previewState.value.status === 'ready' && previewState.value.path === path) return;
  selectedPath.value = path;
  previewState.value = { status: 'loading', path };
  try {
    const response = await getFileContent(path);
    const redactedHint = path === '.saivage/saivage.json' || response.content.includes('[REDACTED]');
    previewState.value = { status: 'ready', path, size: response.size, contentType: response.contentType, content: response.content, redactedHint };
  } catch (err) {
    const apiErr = err as ApiError;
    let status: 'missing' | 'blocked' | 'directory' | 'too_large' | 'binary' | 'error' = 'error';
    let message = 'Could not load preview.';
    if (apiErr?.status === 404) { status = 'missing'; message = 'File was recorded as evidence but is not present in the workspace.'; }
    else if (apiErr?.status === 403) { status = 'blocked'; message = 'Preview blocked by file-access security.'; }
    else if (apiErr?.status === 400) { status = 'directory'; message = 'This evidence path points to a directory, not a previewable file.'; }
    else if (apiErr?.status === 413) { status = 'too_large'; message = 'File is too large to preview.'; }
    else if (apiErr?.status === 415) { status = 'binary'; message = 'Binary or non-text file cannot be previewed here.'; }
    else if (apiErr instanceof Error && apiErr.message) { message = apiErr.message; }
    previewState.value = { status, path, message };
  }
}

function navigateCard(id: string): void { emit('navigate', id); }

onMounted(async () => { try { await cardStore.fetchCardDetail(props.cardId); } catch (err) { log.error('fetch', err); } });
watch(() => props.cardId, async (nid) => {
  selectedPath.value = null;
  previewState.value = { status: 'idle' };
  if (nid) { try { await cardStore.fetchCardDetail(nid); } catch (err) { log.error('fetch', err); } }
});
</script>

<style scoped>
.card-detail-container { flex:1; overflow-y:auto; padding:20px; }
.detail-loading,.detail-error,.preview-empty { padding:16px; color:#8b949e; font-size:13px; }
.detail-error { color:#f85149; }
.detail-section { margin-bottom:20px; padding-bottom:16px; border-bottom:1px solid #21262d; }
.section-heading,.subheading { font-size:12px; font-weight:600; color:#8b949e; text-transform:uppercase; margin:0 0 10px 0; }
.header-section { padding-bottom:12px; }
.detail-title-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.detail-type-badge,.badge { font-size:12px; padding:2px 8px; border-radius:4px; background:#21262d; border:1px solid #30363d; color:#c9d1d9; }
.badge.subtle { color:#8b949e; }
.badge.success { color:#7ee787; }
.badge.warning { color:#d29922; }
.badge.error { color:#f85149; }
.detail-title { font-size:20px; font-weight:600; color:#f0f6fc; margin:0; }
.detail-status-chip { font-size:11px; font-weight:600; padding:2px 10px; border-radius:10px; text-transform:uppercase; border:1px solid transparent; }
.status-active,.status-running { background:#1c2738; color:#58a6ff; border-color:#1f6feb; }
.status-done { background:#1a2418; color:#7ee787; border-color:#238636; }
.status-failed { background:#241818; color:#f85149; border-color:#da3633; }
.status-backlog,.status-drafting,.status-cancelled,.status-blocked { background:#21262d; color:#c9d1d9; border-color:#484f58; }
.detail-id,.generated-file-path,.detail-json { font-family:'SF Mono',monospace; }
.meta-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:8px; }
.meta-item { display:flex; flex-direction:column; gap:2px; }
.meta-key { font-size:11px; color:#8b949e; }
.meta-value { font-size:13px; color:#c9d1d9; }
.notes-list,.generated-files-list { display:flex; flex-direction:column; gap:8px; }
.note-item,.generated-file-row,.verification-row { background:#161b22; border:1px solid #21262d; border-radius:6px; padding:10px 12px; }
.generated-file-row { text-align:left; cursor:pointer; }
.generated-file-row.selected { border-color:#58a6ff; }
.generated-file-main { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.generated-file-description,.note-content,.evidence-summary { color:#8b949e; font-size:12px; }
.preview-panel { margin-top:12px; }
.preview-header { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:8px; color:#8b949e; font-size:12px; }
.preview-notice { padding:10px 12px; border-radius:6px; background:#1c2738; color:#c9d1d9; margin-bottom:8px; }
.preview-notice.warning { background:#241f18; }
.preview-notice.error { background:#241818; }
.preview-content,.detail-json { background:#0d1117; border:1px solid #21262d; border-radius:4px; padding:12px; font-size:12px; line-height:1.5; overflow-x:auto; white-space:pre-wrap; word-break:break-word; color:#c9d1d9; margin:0; }
.retry-btn { padding:6px 10px; background:#21262d; border:1px solid #30363d; color:#c9d1d9; border-radius:4px; cursor:pointer; }
.empty-evidence { color:#8b949e; font-size:13px; padding:8px 0; }
</style>
