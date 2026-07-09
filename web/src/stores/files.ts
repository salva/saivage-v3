/**
 * Pinia store for file browsing.
 *
 * Manages metadata browser (.saivage/) and work browser (.saivage/work/)
 * with breadcrumb navigation, directory stats, JSON highlighting,
 * and Markdown rendering support. Respects file API protections.
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { FileEntry, FileContent, FilesListResponse, FreshnessState } from '../api/types';
import { listFiles, getFileContent, ApiError } from '../api/client';
import { createLogger } from '../utils/logger';

const log = createLogger('store:files');
const STALE_AFTER_MS = 30_000;
let fileContentRequestSeq = 0;

// ── Constants ──────────────────────────────────────────────────

/** Root paths exposed by the server file browser. */
const METADATA_ROOT = '.saivage';
const OUTPUT_ROOT = '.saivage/work';

// ── Helpers ────────────────────────────────────────────────────

function buildBreadcrumbs(currentPath: string, root: string): { label: string; path: string }[] {
  const crumbs: { label: string; path: string }[] = [{ label: root, path: root }];

  if (currentPath === root || !currentPath.startsWith(root)) {
    return crumbs;
  }

  const relative = currentPath.slice(root.length).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!relative) return crumbs;

  const parts = relative.split('/');
  let accumulated = root;
  for (const part of parts) {
    accumulated = accumulated.replace(/\/+$/, '') + '/' + part;
    crumbs.push({ label: part, path: accumulated });
  }

  return crumbs;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Store ──────────────────────────────────────────────────────

export const useFileStore = defineStore('files', () => {
  // ── State ──────────────────────────────────────────────────

  // Metadata browser (.saivage/)
  const metaPath = ref<string>(METADATA_ROOT);
  const metaFiles = ref<FileEntry[]>([]);
  const metaLoading = ref(false);
  const metaLastFetchedAt = ref<string | null>(null);

  // Work browser (.saivage/work/)
  const outputPath = ref<string>(OUTPUT_ROOT);
  const outputFiles = ref<FileEntry[]>([]);
  const outputLoading = ref(false);
  const outputLastFetchedAt = ref<string | null>(null);

  // File content viewer
  const viewedFile = ref<FileContent | null>(null);
  const viewedFilePath = ref<string>('');
  const contentLoading = ref(false);
  const viewerLastFetchedAt = ref<string | null>(null);
  const viewerState = ref<'idle' | 'ready' | 'blocked' | 'missing' | 'binary' | 'too-large' | 'directory' | 'error'>('idle');

  // Shared
  const error = ref<string | null>(null);
  const listError = ref<string | null>(null);
  const viewerError = ref<string | null>(null);
  const unauthorized = ref(false);
  const lastWsEventAt = ref<string | null>(null);
  const lastUpdatedBy = ref<FreshnessState['lastUpdatedBy']>('unknown');

  // ── Getters ────────────────────────────────────────────────

  const metaBreadcrumbs = computed(() =>
    buildBreadcrumbs(metaPath.value, METADATA_ROOT),
  );

  const outputBreadcrumbs = computed(() =>
    buildBreadcrumbs(outputPath.value, OUTPUT_ROOT),
  );

  /** Detects if viewed file should be rendered as JSON. */
  const isJsonContent = computed<boolean>(() => {
    if (!viewedFile.value) return false;
    const ct = viewedFile.value.contentType;
    return ct === 'application/json'
      || ct.includes('+json')
      || viewedFilePath.value.endsWith('.json');
  });

  /** Detects if viewed file should be rendered as Markdown. */
  const isMarkdownContent = computed<boolean>(() => {
    return viewedFilePath.value.endsWith('.md')
      || viewedFile.value?.contentType === 'text/markdown';
  });

  const lastFetchedAt = computed(() => viewerLastFetchedAt.value ?? outputLastFetchedAt.value ?? metaLastFetchedAt.value);
  const isStale = computed(() => {
    const latest = lastWsEventAt.value ?? lastFetchedAt.value;
    if (!latest) return false;
    return Date.now() - new Date(latest).getTime() > STALE_AFTER_MS;
  });

  function markRestSync(target: 'meta' | 'output' | 'viewer'): void {
    const now = nowIso();
    if (target === 'meta') metaLastFetchedAt.value = now;
    if (target === 'output') outputLastFetchedAt.value = now;
    if (target === 'viewer') viewerLastFetchedAt.value = now;
    lastUpdatedBy.value = 'rest';
  }

  function markWsSync(timestamp = nowIso()): void {
    lastWsEventAt.value = timestamp;
    lastUpdatedBy.value = 'ws';
  }

  function handleApiError(err: unknown, fallback: string): string {
    unauthorized.value = err instanceof ApiError && err.isUnauthorized;
    if (err instanceof ApiError) return err.message;
    return fallback;
  }

  // ── Actions: Metadata Browser ──────────────────────────────

  async function fetchMetaFiles(path?: string): Promise<void> {
    metaLoading.value = true;
    error.value = null;
    listError.value = null;
    const p = path || metaPath.value;
    try {
      const response: FilesListResponse = await listFiles(p);
      metaFiles.value = response.files;
      metaPath.value = response.path;
      markRestSync('meta');
    } catch (err) {
      const msg = handleApiError(err, 'Failed to list metadata files');
      error.value = msg;
      listError.value = msg;
      log.error('fetchMetaFiles', msg);
    } finally {
      metaLoading.value = false;
    }
  }

  async function navigateMeta(path: string): Promise<void> {
    if (path !== metaPath.value) clearViewedFile();
    metaPath.value = path;
    await fetchMetaFiles(path);
  }

  async function navigateMetaUp(): Promise<void> {
    if (metaPath.value === METADATA_ROOT) return;
    const parts = metaPath.value.split('/');
    parts.pop();
    const parent = parts.join('/') || METADATA_ROOT;
    await navigateMeta(parent);
  }

  // ── Actions: Output Browser ─────────────────────────────────

  async function fetchOutputFiles(path?: string): Promise<void> {
    outputLoading.value = true;
    error.value = null;
    listError.value = null;
    const p = path || outputPath.value;
    try {
      const response: FilesListResponse = await listFiles(p);
      outputFiles.value = response.files;
      outputPath.value = response.path;
      markRestSync('output');
    } catch (err) {
      const msg = handleApiError(err, 'Failed to list output files');
      error.value = msg;
      listError.value = msg;
      log.error('fetchOutputFiles', msg);
    } finally {
      outputLoading.value = false;
    }
  }

  async function navigateOutput(path: string): Promise<void> {
    if (path !== outputPath.value) clearViewedFile();
    outputPath.value = path;
    await fetchOutputFiles(path);
  }

  async function navigateOutputUp(): Promise<void> {
    if (outputPath.value === OUTPUT_ROOT) return;
    const parts = outputPath.value.split('/');
    parts.pop();
    const parent = parts.join('/') || OUTPUT_ROOT;
    await navigateOutput(parent);
  }

  // ── Actions: File Content ──────────────────────────────────

  async function fetchFileContent(path: string): Promise<void> {
    const requestSeq = ++fileContentRequestSeq;
    contentLoading.value = true;
    error.value = null;
    viewerError.value = null;
    viewerState.value = 'idle';
    viewedFile.value = null;
    viewedFilePath.value = path;
    try {
      const response: FileContent = await getFileContent(path);
      if (requestSeq !== fileContentRequestSeq || viewedFilePath.value !== path) return;
      viewedFile.value = response;
      viewerState.value = 'ready';
      markRestSync('viewer');
    } catch (err) {
      if (requestSeq !== fileContentRequestSeq || viewedFilePath.value !== path) return;
      const msg = handleApiError(err, 'Failed to fetch file content');
      error.value = msg;
      viewerError.value = msg;
      if (err instanceof ApiError) {
        if (err.status === 403) viewerState.value = 'blocked';
        else if (err.status === 404) viewerState.value = 'missing';
        else if (err.status === 415) viewerState.value = 'binary';
        else if (err.status === 413) viewerState.value = 'too-large';
        else if (err.status === 400) viewerState.value = 'directory';
        else viewerState.value = 'error';
      } else {
        viewerState.value = 'error';
      }
      log.error('fetchFileContent', msg);
    } finally {
      if (requestSeq === fileContentRequestSeq) contentLoading.value = false;
    }
  }

  function clearViewedFile(): void {
    viewedFile.value = null;
    viewedFilePath.value = '';
    viewerState.value = 'idle';
    viewerError.value = null;
  }

  async function refetch(): Promise<void> {
    await Promise.all([fetchMetaFiles(), fetchOutputFiles()]);
    if (viewedFilePath.value) await fetchFileContent(viewedFilePath.value);
  }

  return {
    // State
    metaPath,
    metaFiles,
    metaLoading,
    outputPath,
    outputFiles,
    outputLoading,
    viewedFile,
    viewedFilePath,
    contentLoading,
    error,
    listError,
    viewerError,
    viewerState,
    lastFetchedAt,
    metaLastFetchedAt,
    outputLastFetchedAt,
    viewerLastFetchedAt,
    lastWsEventAt,
    lastUpdatedBy,
    unauthorized,
    isStale,

    // Getters
    metaBreadcrumbs,
    outputBreadcrumbs,
    isJsonContent,
    isMarkdownContent,

    // Actions
    fetchMetaFiles,
    navigateMeta,
    navigateMetaUp,
    fetchOutputFiles,
    navigateOutput,
    navigateOutputUp,
    fetchFileContent,
    clearViewedFile,
    markWsSync,
    refetch,
  };
});
