/**
 * Pinia store for file browsing.
 *
 * Manages metadata browser (.saivage/) and work browser (.saivage/work/)
 * with breadcrumb navigation, directory stats, JSON highlighting,
 * and Markdown rendering support. Respects file API protections.
 */

import { defineStore } from 'pinia';
import { ref, computed, onScopeDispose } from 'vue';
import type { FileEntry, FileContent, FilesListResponse } from '../api/types';
import { listFiles, getFileContent, OperatorApiError } from '../api/client';
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

  // Work browser (.saivage/work/)
  const outputPath = ref<string>(OUTPUT_ROOT);
  const outputFiles = ref<FileEntry[]>([]);
  const outputLoading = ref(false);

  // File content viewer
  const viewedFile = ref<FileContent | null>(null);
  const viewedFilePath = ref<string>('');
  const contentLoading = ref(false);
  const viewerState = ref<'idle' | 'ready' | 'blocked' | 'missing' | 'binary' | 'too-large' | 'directory' | 'error'>('idle');

  // Shared
  const listError = ref<string | null>(null);
  const viewerError = ref<string | null>(null);
  const unauthorized = ref(false);
  const lastFetchedAt = ref<string | null>(null);
  const isStale = ref(false);
  let staleTimer: ReturnType<typeof setTimeout> | undefined;

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

  function markRestSnapshotCompleted(): void {
    lastFetchedAt.value = nowIso();
    isStale.value = false;
    if (staleTimer !== undefined) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      staleTimer = undefined;
      isStale.value = true;
    }, STALE_AFTER_MS);
  }

  onScopeDispose(() => {
    if (staleTimer !== undefined) clearTimeout(staleTimer);
  });

  function handleApiError(err: unknown, fallback: string): string {
    unauthorized.value = err instanceof OperatorApiError && err.isUnauthorized;
    if (err instanceof OperatorApiError) return err.message;
    return fallback;
  }

  // ── Actions: Metadata Browser ──────────────────────────────

  async function fetchMetaFiles(path?: string): Promise<void> {
    metaLoading.value = true;
    listError.value = null;
    const p = path || metaPath.value;
    try {
      const response: FilesListResponse = await listFiles(p);
      metaFiles.value = response.files;
      metaPath.value = response.path;
      markRestSnapshotCompleted();
    } catch (err) {
      const msg = handleApiError(err, 'Failed to list metadata files');
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

  // ── Actions: Output Browser ─────────────────────────────────

  async function fetchOutputFiles(path?: string): Promise<void> {
    outputLoading.value = true;
    listError.value = null;
    const p = path || outputPath.value;
    try {
      const response: FilesListResponse = await listFiles(p);
      outputFiles.value = response.files;
      outputPath.value = response.path;
      markRestSnapshotCompleted();
    } catch (err) {
      const msg = handleApiError(err, 'Failed to list output files');
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

  // ── Actions: File Content ──────────────────────────────────

  async function fetchFileContent(path: string): Promise<void> {
    const requestSeq = ++fileContentRequestSeq;
    contentLoading.value = true;
    viewerError.value = null;
    viewerState.value = 'idle';
    viewedFile.value = null;
    viewedFilePath.value = path;
    try {
      const response: FileContent = await getFileContent(path);
      if (requestSeq !== fileContentRequestSeq || viewedFilePath.value !== path) return;
      viewedFile.value = response;
      viewerState.value = 'ready';
      markRestSnapshotCompleted();
    } catch (err) {
      if (requestSeq !== fileContentRequestSeq || viewedFilePath.value !== path) return;
      const msg = handleApiError(err, 'Failed to fetch file content');
      viewerError.value = msg;
      if (err instanceof OperatorApiError) {
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
    listError,
    viewerError,
    viewerState,
    lastFetchedAt,
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
    fetchOutputFiles,
    navigateOutput,
    fetchFileContent,
    clearViewedFile,
  };
});
