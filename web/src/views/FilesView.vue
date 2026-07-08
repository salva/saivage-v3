<template>
  <div class="files-layout" data-testid="route-files">
    <StatusBanner
      v-if="isStale || unauthorized"
      class="files-status-banner"
      :tone="unauthorized ? 'unauthorized' : 'stale'"
      :message="unauthorized ? 'API access is unauthorized. Re-enter a valid token to browse files; public docs at /docs/ remain available.' : 'File listing may be stale. Refresh to resync with the authoritative REST snapshot.'"
      data-testid="files-status-banner"
    />

    <StatusBanner v-if="listError" class="files-status-banner" tone="danger" :message="listError" data-testid="files-list-error" />

    <Panel as="section" class="file-browser" :padded="false" :aria-label="activeRootLabel" data-testid="files-canonical-panel">
      <PanelHeader :title="activeRootLabel">
        <template #meta><span class="code-inline root-label">{{ activeRootPath }}/</span></template>
        <template #actions>
          <div class="root-switcher" role="group" aria-label="File root">
            <button class="pill" :aria-pressed="activeRoot === 'meta'" @click="goToRoot('meta')">Metadata</button>
            <button class="pill" :aria-pressed="activeRoot === 'output'" @click="goToRoot('output')">Output</button>
          </div>
          <button class="btn refresh-button" :disabled="activeLoading" title="Refresh" data-testid="files-refresh" @click="refreshActiveRoot">↻</button>
        </template>
      </PanelHeader>
      <div class="file-breadcrumbs" data-testid="files-breadcrumbs">
        <button
          v-for="(crumb, idx) in activeBreadcrumbs"
          :key="crumb.path"
          class="pill crumb-button"
          :aria-pressed="idx === activeBreadcrumbs.length - 1"
          @click="openDirectory(crumb.path)"
        >{{ crumb.label }}</button>
      </div>

      <ViewState v-if="activeLoading" class="loading-state" state="loading" title="Loading files" data-testid="files-loading" />
      <div v-else class="file-list" data-testid="files-list">
        <SelectableRow
          v-for="entry in activeFiles"
          :key="entry.path"
          class="file-entry"
          :class="{ 'is-dir': entry.type === 'directory' }"
          @select="openEntry(entry)"
        >
          <span class="entry-icon">{{ entry.type === 'directory' ? '📁' : fileIcon(entry.name) }}</span>
          <span class="entry-name">{{ entry.name }}</span>
          <span v-if="entry.type === 'file' && entry.size != null" class="entry-size">{{ fmtSize(entry.size) }}</span>
          <span class="entry-modified" :title="timestampTitle(entry.modifiedAt)">{{ fmtDate(entry.modifiedAt) }}</span>
        </SelectableRow>
        <ViewState v-if="activeFiles.length === 0 && !activeLoading" class="empty-state" state="empty" title="No files" data-testid="files-empty" />
      </div>

      <div v-if="activeRoot === 'output'" class="quarantine-footer">
        <div class="quarantine-footer-label">Quarantine</div>
        <button class="btn quarantine-footer-btn" @click="goToPath('output', '.saivage-work/quarantine')">Browse .saivage-work/quarantine/</button>
      </div>
    </Panel>

    <section v-if="cardChildren.length > 0" class="card-children-listing" data-testid="files-view-card-children">
      <h3 class="panel-title">Current Card Children</h3>
      <ul data-testid="files-card-children-list">
        <li v-for="child in cardChildren" :key="child.id" data-testid="files-card-children-item">
          <span class="title">{{ child.title }}</span>
          <span class="status">{{ child.status }}</span>
        </li>
      </ul>
    </section>

    <div v-if="viewedFilePath" class="file-viewer" data-testid="files-viewer">
      <PanelHeader class="viewer-header" :title="viewedFilePath">
        <template #actions><button class="btn viewer-close-btn" @click="fileStore.clearViewedFile()">X</button></template>
      </PanelHeader>
      <ViewState v-if="contentLoading" class="viewer-loading" state="loading" title="Loading preview" />
      <ViewState v-else-if="viewerState !== 'ready'" class="viewer-state" :class="viewerStateClass" :state="viewerStateTone === 'danger' ? 'error' : 'stale'" :tone="viewerStateTone" :title="viewerStateTitle" :message="viewerStateMessage" />
      <div v-else-if="viewedFile" class="viewer-content">
        <StatusBanner v-if="viewedFile.redacted" class="viewer-redaction-notice" tone="neutral" message="Sensitive values were redacted by the server." />
        <CodeBlock v-if="isJsonContent" :code="prettyJsonContent" language="json" copyable />
        <DocumentFrame v-else-if="isMarkdownContent" :title="viewedFilePath" :name="viewedFilePath">
          <MarkdownText :source="viewedFile.content" />
        </DocumentFrame>
        <CodeBlock v-else :code="viewedFile.content" language="text" copyable wrap />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useFileStore } from '../stores/files';
import { useLiveSyncStore } from '../stores/liveSync';
import { useCardStore } from '../stores/cards';
import { selectChildrenOf } from '../stores/cards';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../utils/timestamp';
import { formatJson } from '../utils/format-json';
import CodeBlock from '../components/content/CodeBlock.vue';
import DocumentFrame from '../components/content/DocumentFrame.vue';
import MarkdownText from '../components/content/MarkdownText.vue';
import Panel from '../components/ui/Panel.vue';
import PanelHeader from '../components/ui/PanelHeader.vue';
import SelectableRow from '../components/ui/SelectableRow.vue';
import StatusBanner from '../components/ui/StatusBanner.vue';
import ViewState from '../components/ui/ViewState.vue';
import type { CardRecord, FileEntry } from '../types/view-models';
import type { Tone } from '../utils/status';

type FileRoot = 'meta' | 'output';

const route = useRoute();
const router = useRouter();
const fileStore = useFileStore();
const liveSyncStore = useLiveSyncStore();
const cardsStore = useCardStore();
const {
  metaFiles, metaLoading, metaBreadcrumbs,
  outputFiles, outputLoading, outputBreadcrumbs,
  viewedFile, viewedFilePath, contentLoading,
  isJsonContent, isMarkdownContent,
  listError, viewerError, viewerState,
  isStale, unauthorized,
} = storeToRefs(fileStore);

const activeCardId = computed<string | null>(() => cardsStore.currentCard?.id ?? null);
const cardChildren = computed<CardRecord[]>(() => {
  const id = activeCardId.value;
  return id ? selectChildrenOf([...cardsStore.cards], id) : [];
});
const activeRoot = computed<FileRoot>(() => route.query.root === 'output' ? 'output' : 'meta');
const activeRootPath = computed(() => activeRoot.value === 'meta' ? '.saivage' : '.saivage-work');
const activeRootLabel = computed(() => activeRoot.value === 'meta' ? 'Metadata' : 'Output');
const activeFiles = computed(() => activeRoot.value === 'meta' ? metaFiles.value : outputFiles.value);
const activeLoading = computed(() => activeRoot.value === 'meta' ? metaLoading.value : outputLoading.value);
const activeBreadcrumbs = computed(() => activeRoot.value === 'meta' ? metaBreadcrumbs.value : outputBreadcrumbs.value);

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

const viewerStateTone = computed<Tone>(() => {
  return viewerState.value === 'blocked' || viewerState.value === 'error' || viewerState.value === 'missing'
    ? 'danger'
    : 'warning';
});

const prettyJsonContent = computed(() => {
  const raw = viewedFile.value?.content ?? '';
  try { return formatJson(JSON.parse(raw)); } catch { return raw; }
});

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const icons: Record<string, string> = {
    json: '{}', jsonl: '{}', ndjson: '{}', md: 'MD', ts: 'TS', js: 'JS', txt: 'TX',
    yaml: 'YM', yml: 'YM', toml: 'TO', lock: 'LK', log: 'LG', csv: 'CV', html: '<>', css: '#',
    png: 'PN', jpg: 'IM', jpeg: 'IM', gif: 'IM', svg: 'SV', pdf: 'PD', zip: 'ZP', gz: 'GZ',
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

function parentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function rootForPath(path: string): FileRoot | null {
  if (path === '.saivage' || path.startsWith('.saivage/')) return 'meta';
  if (path === '.saivage-work' || path.startsWith('.saivage-work/')) return 'output';
  return null;
}

function canonicalPathForRoot(rootName: FileRoot, queryPath: unknown): string {
  if (typeof queryPath !== 'string' || queryPath.length === 0) return rootName === 'meta' ? '.saivage' : '.saivage-work';
  return queryPath;
}

function goToRoot(rootName: FileRoot): void {
  void router.push({ name: 'files', query: { root: rootName, path: rootName === 'meta' ? '.saivage' : '.saivage-work' } });
}

function goToPath(rootName: FileRoot, path: string): void {
  void router.push({ name: 'files', query: { root: rootName, path } });
}

function openDirectory(path: string): void {
  goToPath(activeRoot.value, path);
}

function openEntry(entry: FileEntry): void {
  if (entry.type === 'directory') {
    fileStore.clearViewedFile();
    const navigation = activeRoot.value === 'meta' ? fileStore.navigateMeta(entry.path) : fileStore.navigateOutput(entry.path);
    void navigation.then(() => fileStore.clearViewedFile());
    goToPath(activeRoot.value, entry.path);
    return;
  }
  void fileStore.fetchFileContent(entry.path);
}

async function refreshActiveRoot(): Promise<void> {
  const path = canonicalPathForRoot(activeRoot.value, route.query.path);
  if (activeRoot.value === 'meta') await fileStore.fetchMetaFiles(path);
  else await fileStore.fetchOutputFiles(path);
}

function applyQueryPath(): void {
  const rootName = activeRoot.value;
  const path = canonicalPathForRoot(rootName, route.query.path);
  const pathRoot = rootForPath(path);
  if (pathRoot && pathRoot !== rootName) {
    goToPath(pathRoot, path);
    return;
  }
  const browse = rootName === 'meta' ? fileStore.navigateMeta : fileStore.navigateOutput;

  const browseDirectory = async (directoryPath: string): Promise<boolean> => {
    await browse(directoryPath);
    return !fileStore.listError;
  };

  fileStore.clearViewedFile();
  browseDirectory(path)
    .then(async (listedDirectory) => {
      if (listedDirectory) return;

      if (fileStore.unauthorized) return;

      const directory = parentPath(path);
      const listedParent = directory !== path ? await browseDirectory(directory) : false;
      if (fileStore.unauthorized) return;

      if (!listedParent) await browse(activeRootPath.value);
      if (fileStore.unauthorized) return;

      await fileStore.fetchFileContent(path);
    })
    .catch(() => browse(activeRootPath.value))
    .catch(() => {});
}

let unregisterFiles: (() => void) | null = null;
onMounted(() => {
  unregisterFiles = liveSyncStore.registerResource({ resource: 'files', scope: 'active', refetch: fileStore.refetch, onRefetch: fileStore.markWsSync });
});

onUnmounted(() => {
  unregisterFiles?.();
});

watch(() => [route.query.root, route.query.path], () => {
  applyQueryPath();
}, { immediate: true });
</script>

<style scoped>
.files-layout { height:100%; display:flex; flex-direction:column; overflow:hidden; }
.files-status-banner { margin: 12px 12px 0; }
.file-browser { flex:1; display:flex; flex-direction:column; overflow:hidden; border:0; border-bottom:1px solid var(--border); border-radius:0; }
.file-browser :deep(.ui-panel-header) { padding:8px 12px; background:var(--surface-1); border-bottom:1px solid var(--border); margin-bottom:0; }
.file-browser :deep(.ui-panel-header__meta) { margin-top:2px; }
.panel-header { display:flex; align-items:center; gap:12px; padding:8px 12px; background:var(--surface-1); border-bottom:1px solid var(--border); flex-shrink:0; }
.panel-title { font-size:12px; font-weight:600; color:var(--text); margin:0; }
.root-label { font-size:10px; padding:2px 4px; }
.root-switcher { display:flex; align-items:center; gap:6px; margin-left:auto; }
.root-switcher .pill, .crumb-button { cursor:pointer; padding:3px 8px; font-family:inherit; }
.refresh-button { width:28px; height:28px; display:flex; align-items:center; justify-content:center; }
.file-breadcrumbs { display:flex; align-items:center; gap:6px; padding:6px 12px; background:var(--bg); border-bottom:1px solid var(--surface-3); flex-shrink:0; overflow-x:auto; }
.loading-state,.empty-state { padding:16px; justify-content:center; text-align:center; }
.file-list { flex:1; overflow-y:auto; }
.file-entry { gap:8px; padding:6px 12px; transition:background .1s; border-bottom:1px solid var(--surface-3); }
.file-entry:hover { background:var(--surface-1); }
.file-entry.is-dir .entry-name { color:var(--accent-2); font-weight:500; }
.entry-icon { width:22px; text-align:center; flex-shrink:0; font-family:'SF Mono',monospace; color:var(--text-muted); font-size:10px; }
.entry-name { font-size:12px; color:var(--text); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.entry-size { font-size:10px; color:var(--border-strong); font-family:'SF Mono',monospace; }
.entry-modified { font-size:10px; color:var(--border-strong); }
.card-children-listing { border-top:1px solid var(--border); padding:12px; background:var(--bg); }
.card-children-listing ul { margin:8px 0 0; padding-left:18px; }
.card-children-listing li { color:var(--text); font-size:12px; margin:4px 0; }
.card-children-listing .status { color:var(--text-muted); margin-left:8px; }
.file-viewer { border-top:1px solid var(--border); max-height:40%; overflow:hidden; display:flex; flex-direction:column; }
.viewer-header { padding:6px 12px; background:var(--surface-1); border-bottom:1px solid var(--border); flex-shrink:0; margin-bottom:0; }
.viewer-header :deep(.ui-panel-header__title) { font-size:11px; color:var(--accent-2); font-family:'SF Mono',monospace; }
.viewer-close-btn { width:24px; height:24px; display:flex; align-items:center; justify-content:center; }
.viewer-loading { padding:16px; justify-content:center; text-align:center; }
.viewer-state { padding: 16px; }
.viewer-content { flex:1; min-height:0; overflow:auto; padding:12px; }
.viewer-redaction-notice { margin-bottom:8px; }
.quarantine-footer { display:flex; align-items:center; gap:8px; padding:8px 12px; background:var(--surface-2); border-top:1px solid var(--border); flex-shrink:0; }
.quarantine-footer-label { font-size:10px; font-weight:600; color:var(--warn); text-transform:uppercase; letter-spacing:.05em; }
.quarantine-footer-btn { font-size:11px; font-family:'SF Mono',monospace; padding:3px 8px; }
</style>
