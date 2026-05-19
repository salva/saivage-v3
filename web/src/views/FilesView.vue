<template>
  <div class="files-layout">
    <div v-if="isStale || unauthorized" class="files-global-banner" :class="unauthorized ? 'banner-error' : 'banner-warning'">
      <template v-if="unauthorized">
        API access is unauthorized. Re-enter a valid token to browse files; public docs at /docs/ remain available.
      </template>
      <template v-else>
        File listings may be stale. Refresh either pane to resync with the authoritative REST snapshot.
      </template>
    </div>

    <div v-if="listError" class="files-global-banner banner-error">
      {{ listError }}
    </div>

    <div class="files-panels">
      <section class="file-panel">
        <div class="panel-header">
          <h3 class="panel-title">Metadata</h3>
          <span class="panel-root">.saivage/</span>
          <button class="panel-refresh-btn" :disabled="metaLoading" @click="fetchMetaFiles" title="Refresh">*</button>
        </div>

        <div class="file-breadcrumbs">
          <span
            v-for="(crumb, idx) in metaBreadcrumbs"
            :key="idx"
            class="crumb"
            :class="{ active: idx === metaBreadcrumbs.length - 1 }"
          >
            <span v-if="idx > 0" class="crumb-sep">/</span>
            <span class="crumb-link" @click="fileStore.navigateMeta(crumb.path)">{{ crumb.label }}</span>
          </span>
        </div>

        <div v-if="metaLoading" class="panel-loading">Loading...</div>
        <div v-else class="file-list">
          <div
            v-for="entry in metaFiles"
            :key="entry.path"
            class="file-entry"
            :class="{ 'is-dir': entry.type === 'directory' }"
            @click="entry.type === 'directory'
              ? fileStore.navigateMeta(entry.path)
              : fileStore.fetchFileContent(entry.path)"
          >
            <span class="entry-icon">{{ entry.type === 'directory' ? '📁' : fileIcon(entry.name) }}</span>
            <span class="entry-name">{{ entry.name }}</span>
            <span v-if="entry.type === 'file' && entry.size != null" class="entry-size">{{ fmtSize(entry.size) }}</span>
            <span class="entry-modified" :title="timestampTitle(entry.modifiedAt)">{{ fmtDate(entry.modifiedAt) }}</span>
          </div>
          <div v-if="metaFiles.length === 0 && !metaLoading" class="panel-empty">No files</div>
        </div>
      </section>

      <section class="file-panel">
        <div class="panel-header">
          <h3 class="panel-title">Output</h3>
          <span class="panel-root">.saivage-work/</span>
          <button class="panel-refresh-btn" :disabled="outputLoading" @click="fetchOutputFiles" title="Refresh">*</button>
        </div>

        <div class="file-breadcrumbs">
          <span
            v-for="(crumb, idx) in outputBreadcrumbs"
            :key="idx"
            class="crumb"
            :class="{ active: idx === outputBreadcrumbs.length - 1 }"
          >
            <span v-if="idx > 0" class="crumb-sep">/</span>
            <span class="crumb-link" @click="fileStore.navigateOutput(crumb.path)">{{ crumb.label }}</span>
          </span>
        </div>

        <div v-if="outputLoading" class="panel-loading">Loading...</div>
        <div v-else class="file-list">
          <div
            v-for="entry in outputFiles"
            :key="entry.path"
            class="file-entry"
            :class="{ 'is-dir': entry.type === 'directory' }"
            @click="entry.type === 'directory'
              ? fileStore.navigateOutput(entry.path)
              : fileStore.fetchFileContent(entry.path)"
          >
            <span class="entry-icon">{{ entry.type === 'directory' ? '📁' : fileIcon(entry.name) }}</span>
            <span class="entry-name">{{ entry.name }}</span>
            <span v-if="entry.type === 'file' && entry.size != null" class="entry-size">{{ fmtSize(entry.size) }}</span>
            <span class="entry-modified" :title="timestampTitle(entry.modifiedAt)">{{ fmtDate(entry.modifiedAt) }}</span>
          </div>
          <div v-if="outputFiles.length === 0 && !outputLoading" class="panel-empty">No files</div>
        </div>

        <div class="quarantine-footer">
          <div class="quarantine-footer-label">Quarantine</div>
          <button
            class="quarantine-footer-btn"
            @click="fileStore.navigateOutput('.saivage-work/quarantine')"
          >Browse .saivage-work/quarantine/</button>
        </div>
      </section>
    </div>

    <div v-if="viewedFilePath" class="file-viewer">
      <div class="viewer-header">
        <span class="viewer-path">{{ viewedFilePath }}</span>
        <button class="viewer-close-btn" @click="fileStore.clearViewedFile()">X</button>
      </div>
      <div v-if="contentLoading" class="viewer-loading">Loading...</div>
      <div v-else-if="viewerState !== 'ready'" class="viewer-state" :class="viewerStateClass">
        <strong>{{ viewerStateTitle }}</strong>
        <span>{{ viewerStateMessage }}</span>
      </div>
      <div v-else-if="viewedFile" class="viewer-content">
        <div v-if="viewedFile.redacted" class="viewer-redaction-notice">Sensitive values were redacted by the server.</div>
        <pre v-if="isJsonContent" class="json-view">{{ fmtJson(viewedFile.content) }}</pre>
        <div v-else-if="isMarkdownContent" class="md-view" v-html="renderMarkdown(viewedFile.content)"></div>
        <pre v-else class="plain-view">{{ viewedFile.content }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, watch, computed } from 'vue';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useFileStore } from '../stores/files';
import { createLogger } from '../utils/logger';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../utils/timestamp';

const log = createLogger('view:files');

const route = useRoute();
const fileStore = useFileStore();
const {
  metaFiles, metaLoading, metaBreadcrumbs,
  outputFiles, outputLoading, outputBreadcrumbs,
  viewedFile, viewedFilePath, contentLoading,
  isJsonContent, isMarkdownContent,
  listError, viewerError, viewerState,
  isStale, unauthorized,
} = storeToRefs(fileStore);

const viewerStateTitle = computed(() => {
  switch (viewerState.value) {
    case 'blocked': return 'Preview blocked';
    case 'missing': return 'File not found';
    case 'binary': return 'Binary preview unavailable';
    case 'too-large': return 'Preview too large';
    case 'directory': return 'Directory selected';
    case 'error': return 'Preview failed';
    default: return 'Preview unavailable';
  }
});

const viewerStateMessage = computed(() => {
  if (viewerError.value) return viewerError.value;
  switch (viewerState.value) {
    case 'blocked': return 'This file cannot be previewed safely through the control room.';
    case 'missing': return 'The selected file is no longer available at this path.';
    case 'binary': return 'Download or inspect this artifact through a supported non-text workflow.';
    case 'too-large': return 'The file is too large for inline preview; narrow the workflow or inspect logs/artifacts elsewhere.';
    case 'directory': return 'Select a file instead of a directory to open an inline preview.';
    case 'error': return 'The server could not load this file preview.';
    default: return 'No preview is available for this selection.';
  }
});

const viewerStateClass = computed(() => {
  return viewerState.value === 'blocked' || viewerState.value === 'error' || viewerState.value === 'missing'
    ? 'viewer-state-error'
    : 'viewer-state-warning';
});

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const icons: Record<string, string> = {
    json: '{}', jsonl: '{}', ndjson: '{}', md: 'MD', ts: 'TS', js: 'JS', txt: 'TX',
    yaml: 'YM', yml: 'YM', toml: 'TO', lock: 'LK',
    log: 'LG', csv: 'CV', html: '<>', css: '#',
    png: 'PN', jpg: 'IM', jpeg: 'IM', gif: 'IM', svg: 'SV',
    pdf: 'PD', zip: 'ZP', gz: 'GZ',
  };
  return icons[ext || ''] || '--';
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

function fmtDate(ts: string): string {
  return formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute');
}

function fmtJson(content: string): string {
  try { return JSON.stringify(JSON.parse(content), null, 2); }
  catch { return content; }
}

function esc(text: string): string {
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderMarkdown(text: string): string {
  let out = esc(text);
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block"><code>$2</code></pre>');
  out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\n/g, '<br>');
  return out;
}

async function fetchMetaFiles(): Promise<void> {
  try { await fileStore.fetchMetaFiles(); } catch { }
}

async function fetchOutputFiles(): Promise<void> {
  try { await fileStore.fetchOutputFiles(); } catch { }
}

function applyQueryPath(): void {
  const p = route.query.path;
  if (typeof p === 'string' && p.startsWith('.saivage-work/')) {
    log.info('applyQueryPath navigating output panel to', p);
    fileStore.navigateOutput(p).catch(() => {});
  }
}

onMounted(() => {
  fileStore.setupWsListener();
  fetchMetaFiles();
  fetchOutputFiles();
  applyQueryPath();
});

watch(() => route.query.path, () => {
  applyQueryPath();
});
</script>

<style scoped>
.files-layout { height:100%; display:flex; flex-direction:column; overflow:hidden; }
.files-global-banner { margin: 12px 12px 0; padding: 10px 12px; border-radius: 6px; font-size: 12px; }
.banner-warning { background:#241f18; border:1px solid #9e6a03; color:#d29922; }
.banner-error { background:#241818; border:1px solid #da3633; color:#f85149; }
.files-panels { flex:1; display:flex; overflow:hidden; }
.file-panel { flex:1; display:flex; flex-direction:column; border-right:1px solid #30363d; overflow:hidden; }
.file-panel:last-child { border-right:none; }
.panel-header { display:flex; align-items:center; gap:8px; padding:8px 12px; background:#161b22; border-bottom:1px solid #30363d; flex-shrink:0; }
.panel-title { font-size:12px; font-weight:600; color:#f0f6fc; margin:0; }
.panel-root { font-size:10px; color:#484f58; font-family:'SF Mono',monospace; }
.panel-refresh-btn { background:none; border:1px solid #30363d; border-radius:4px; color:#8b949e; cursor:pointer; width:24px; height:24px; font-size:14px; display:flex; align-items:center; justify-content:center; margin-left:auto; }
.panel-refresh-btn:hover:not(:disabled) { color:#58a6ff; border-color:#58a6ff; }
.panel-refresh-btn:disabled { opacity:.5; cursor:not-allowed; }
.file-breadcrumbs { display:flex; align-items:center; gap:2px; padding:6px 12px; background:#0d1117; border-bottom:1px solid #21262d; flex-shrink:0; overflow-x:auto; }
.crumb { font-size:11px; color:#484f58; }
.crumb.active .crumb-link { color:#58a6ff; }
.crumb-sep { margin:0 2px; color:#30363d; }
.crumb-link { cursor:pointer; transition:color .1s; }
.crumb-link:hover { color:#c9d1d9; }
.panel-loading,.panel-empty { padding:16px; text-align:center; color:#484f58; font-size:12px; }
.file-list { flex:1; overflow-y:auto; }
.file-entry { display:flex; align-items:center; gap:8px; padding:6px 12px; cursor:pointer; transition:background .1s; border-bottom:1px solid #21262d; }
.file-entry:hover { background:#161b22; }
.file-entry.is-dir .entry-name { color:#58a6ff; font-weight:500; }
.entry-icon { width:22px; text-align:center; flex-shrink:0; font-family:'SF Mono',monospace; color:#8b949e; font-size:10px; }
.entry-name { font-size:12px; color:#c9d1d9; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.entry-size { font-size:10px; color:#484f58; font-family:'SF Mono',monospace; }
.entry-modified { font-size:10px; color:#484f58; }
.file-viewer { border-top:1px solid #30363d; max-height:40%; overflow:hidden; display:flex; flex-direction:column; }
.viewer-header { display:flex; align-items:center; justify-content:space-between; padding:6px 12px; background:#161b22; border-bottom:1px solid #30363d; flex-shrink:0; }
.viewer-path { font-size:11px; color:#58a6ff; font-family:'SF Mono',monospace; }
.viewer-close-btn { background:none; border:1px solid #30363d; border-radius:4px; color:#8b949e; cursor:pointer; width:24px; height:24px; font-size:14px; display:flex; align-items:center; justify-content:center; }
.viewer-close-btn:hover { color:#f85149; border-color:#f85149; }
.viewer-loading { padding:16px; text-align:center; color:#484f58; font-size:12px; }
.viewer-state { padding: 16px; display:flex; flex-direction:column; gap:6px; font-size:12px; }
.viewer-state-error { color:#f85149; background:#241818; }
.viewer-state-warning { color:#d29922; background:#241f18; }
.viewer-content { flex:1; overflow:auto; padding:12px; }
.viewer-redaction-notice { margin-bottom:8px; padding:10px 12px; border-radius:6px; background:#1c2738; color:#c9d1d9; font-size:12px; }
.json-view { margin:0; padding:12px; background:#0d1117; border:1px solid #21262d; border-radius:4px; font-size:12px; font-family:'SF Mono',monospace; line-height:1.5; white-space:pre-wrap; word-break:break-word; color:#c9d1d9; }
.md-view { font-size:13px; line-height:1.6; color:#c9d1d9; }
.md-view :deep(.code-block) { background:#0d1117; border:1px solid #30363d; border-radius:4px; padding:10px 12px; margin:8px 0; overflow-x:auto; font-size:12px; font-family:'SF Mono',monospace; }
.md-view :deep(.inline-code) { background:#21262d; padding:1px 5px; border-radius:3px; font-size:12px; font-family:'SF Mono',monospace; color:#d2a8ff; }
.md-view :deep(strong) { color:#f0f6fc; }
.plain-view { margin:0; padding:12px; background:#0d1117; border:1px solid #21262d; border-radius:4px; font-size:12px; font-family:'SF Mono',monospace; line-height:1.5; white-space:pre-wrap; word-break:break-word; color:#c9d1d9; }
.quarantine-footer { display:flex; align-items:center; gap:8px; padding:8px 12px; background:#1a1f24; border-top:1px solid #30363d; flex-shrink:0; }
.quarantine-footer-label { font-size:10px; font-weight:600; color:#d29922; text-transform:uppercase; letter-spacing:.05em; }
.quarantine-footer-btn { background:none; border:1px solid #30363d; border-radius:4px; color:#8b949e; cursor:pointer; font-size:11px; font-family:'SF Mono',monospace; padding:3px 8px; transition:all .15s; }
.quarantine-footer-btn:hover { color:#d29922; border-color:#d29922; }
</style>
