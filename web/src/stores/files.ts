/**
 * Pinia store for file browsing.
 *
 * Manages metadata browser (.saivage/) and output browser (.saivage-work/)
 * with breadcrumb navigation, directory stats, JSON highlighting,
 * and Markdown rendering support. Respects file API protections.
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { FileEntry, FileContent, FilesListResponse } from '../api/types';
import { listFiles, getFileContent, ApiError } from '../api/client';
import { createLogger } from '../utils/logger';

const log = createLogger('store:files');

// ── Constants ──────────────────────────────────────────────────

/** Root paths exposed by the server file browser. */
const METADATA_ROOT = '.saivage';
const OUTPUT_ROOT = '.saivage-work';

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

// ── Store ──────────────────────────────────────────────────────

export const useFileStore = defineStore('files', () => {
  // ── State ──────────────────────────────────────────────────

  // Metadata browser (.saivage/)
  const metaPath = ref<string>(METADATA_ROOT);
  const metaFiles = ref<FileEntry[]>([]);
  const metaLoading = ref(false);

  // Output browser (.saivage-work/)
  const outputPath = ref<string>(OUTPUT_ROOT);
  const outputFiles = ref<FileEntry[]>([]);
  const outputLoading = ref(false);

  // File content viewer
  const viewedFile = ref<FileContent | null>(null);
  const viewedFilePath = ref<string>('');
  const contentLoading = ref(false);

  // Shared
  const error = ref<string | null>(null);

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
    return ct === 'application/json' ||
      ct.includes('+json') ||
      viewedFilePath.value.endsWith('.json');
  });

  /** Detects if viewed file should be rendered as Markdown. */
  const isMarkdownContent = computed<boolean>(() => {
    return viewedFilePath.value.endsWith('.md') ||
      viewedFile.value?.contentType === 'text/markdown';
  });

  // ── Actions: Metadata Browser ──────────────────────────────

  async function fetchMetaFiles(path?: string): Promise<void> {
    metaLoading.value = true;
    error.value = null;
    const p = path || metaPath.value;
    try {
      const response: FilesListResponse = await listFiles(p);
      metaFiles.value = response.files;
      metaPath.value = response.path;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to list metadata files';
      error.value = msg;
      log.error('fetchMetaFiles', msg);
    } finally {
      metaLoading.value = false;
    }
  }

  async function navigateMeta(path: string): Promise<void> {
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
    const p = path || outputPath.value;
    try {
      const response: FilesListResponse = await listFiles(p);
      outputFiles.value = response.files;
      outputPath.value = response.path;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to list output files';
      error.value = msg;
      log.error('fetchOutputFiles', msg);
    } finally {
      outputLoading.value = false;
    }
  }

  async function navigateOutput(path: string): Promise<void> {
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
    contentLoading.value = true;
    error.value = null;
    try {
      const response: FileContent = await getFileContent(path);
      viewedFile.value = response;
      viewedFilePath.value = path;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch file content';
      error.value = msg;
      log.error('fetchFileContent', msg);
    } finally {
      contentLoading.value = false;
    }
  }

  function clearViewedFile(): void {
    viewedFile.value = null;
    viewedFilePath.value = '';
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
  };
});
