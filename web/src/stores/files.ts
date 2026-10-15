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
import { createOwnedFetch } from './owned-fetch';

const log = createLogger('store:files');
const LISTING_AGE_AFTER_MS = 30_000;
type ListingAge = 'unobserved' | 'recent' | 'aged';

// ── Constants ──────────────────────────────────────────────────

/** Root paths exposed by the server file browser. */
const METADATA_ROOT = '.saivage';
const OUTPUT_ROOT = '.saivage/work';

interface ListRequestOwner {
  readonly sequence: number;
  readonly controller: AbortController;
}

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
  const metaError = ref<string | null>(null);
  const metaListingAge = ref<ListingAge>('unobserved');
  let metaAgeTimer: ReturnType<typeof setTimeout> | undefined;

  // Work browser (.saivage/work/)
  const outputPath = ref<string>(OUTPUT_ROOT);
  const outputFiles = ref<FileEntry[]>([]);
  const outputLoading = ref(false);
  const outputError = ref<string | null>(null);
  const outputListingAge = ref<ListingAge>('unobserved');
  let outputAgeTimer: ReturnType<typeof setTimeout> | undefined;

  // File content viewer
  const viewedFile = ref<FileContent | null>(null);
  const viewedFilePath = ref<string>('');
  const contentRequest = createOwnedFetch();
  const contentLoading = contentRequest.pending;
  const viewerState = ref<'idle' | 'ready' | 'blocked' | 'missing' | 'card-missing' | 'binary' | 'too-large' | 'directory' | 'error'>('idle');

  // Shared
  const viewerError = ref<string | null>(null);
  const unauthorized = ref(false);
  let metaRequestSequence = 0;
  let outputRequestSequence = 0;
  let metaRequestOwner: ListRequestOwner | undefined;
  let outputRequestOwner: ListRequestOwner | undefined;

  // ── Getters ────────────────────────────────────────────────

  const metaBreadcrumbs = computed(() =>
    buildBreadcrumbs(metaPath.value, METADATA_ROOT),
  );

  const outputBreadcrumbs = computed(() =>
    buildBreadcrumbs(outputPath.value, OUTPUT_ROOT),
  );

  /** Detects if viewed file should be rendered as JSON. */
  const isJsonContent = computed<boolean>(() => {
    if (!viewedFile.value || !('content' in viewedFile.value)) return false;
    const ct = viewedFile.value.contentType;
    return ct === 'application/json'
      || ct.includes('+json')
      || viewedFilePath.value.endsWith('.json');
  });

  /** Detects if viewed file should be rendered as Markdown. */
  const isMarkdownContent = computed<boolean>(() => {
    if (!viewedFile.value || !('content' in viewedFile.value)) return false;
    return viewedFilePath.value.endsWith('.md')
      || viewedFile.value?.contentType === 'text/markdown';
  });

  onScopeDispose(() => {
    contentRequest.cancel();
    if (metaAgeTimer !== undefined) clearTimeout(metaAgeTimer);
    if (outputAgeTimer !== undefined) clearTimeout(outputAgeTimer);
    const metaOwner = metaRequestOwner;
    metaRequestOwner = undefined;
    metaOwner?.controller.abort();
    const outputOwner = outputRequestOwner;
    outputRequestOwner = undefined;
    outputOwner?.controller.abort();
  });

  function handleApiError(err: unknown, fallback: string): string {
    unauthorized.value = err instanceof OperatorApiError && err.isUnauthorized;
    if (err instanceof OperatorApiError) return err.message;
    return fallback;
  }

  // ── Actions: Metadata Browser ──────────────────────────────

  async function fetchMetaFiles(path?: string): Promise<void> {
    metaRequestOwner?.controller.abort();
    const owner: ListRequestOwner = {
      sequence: ++metaRequestSequence,
      controller: new AbortController(),
    };
    metaRequestOwner = owner;
    metaLoading.value = true;
    metaError.value = null;
    const p = path || metaPath.value;
    try {
      const response: FilesListResponse = await listFiles(p, owner.controller.signal);
      if (metaRequestOwner !== owner || metaRequestOwner.sequence !== owner.sequence) return;
      metaFiles.value = response.files;
      metaPath.value = response.path;
      metaListingAge.value = 'recent';
      if (metaAgeTimer !== undefined) clearTimeout(metaAgeTimer);
      metaAgeTimer = setTimeout(() => {
        metaAgeTimer = undefined;
        metaListingAge.value = 'aged';
      }, LISTING_AGE_AFTER_MS);
    } catch (err) {
      if (metaRequestOwner !== owner || owner.controller.signal.aborted) return;
      const msg = handleApiError(err, 'Failed to list metadata files');
      metaError.value = msg;
      log.error('fetchMetaFiles', msg);
    } finally {
      if (metaRequestOwner === owner && !owner.controller.signal.aborted) {
        metaLoading.value = false;
        metaRequestOwner = undefined;
      }
    }
  }

  async function navigateMeta(path: string): Promise<void> {
    if (path !== metaPath.value) clearViewedFile();
    await fetchMetaFiles(path);
  }

  // ── Actions: Output Browser ─────────────────────────────────

  async function fetchOutputFiles(path?: string): Promise<void> {
    outputRequestOwner?.controller.abort();
    const owner: ListRequestOwner = {
      sequence: ++outputRequestSequence,
      controller: new AbortController(),
    };
    outputRequestOwner = owner;
    outputLoading.value = true;
    outputError.value = null;
    const p = path || outputPath.value;
    try {
      const response: FilesListResponse = await listFiles(p, owner.controller.signal);
      if (outputRequestOwner !== owner || outputRequestOwner.sequence !== owner.sequence) return;
      outputFiles.value = response.files;
      outputPath.value = response.path;
      outputListingAge.value = 'recent';
      if (outputAgeTimer !== undefined) clearTimeout(outputAgeTimer);
      outputAgeTimer = setTimeout(() => {
        outputAgeTimer = undefined;
        outputListingAge.value = 'aged';
      }, LISTING_AGE_AFTER_MS);
    } catch (err) {
      if (outputRequestOwner !== owner || owner.controller.signal.aborted) return;
      const msg = handleApiError(err, 'Failed to list output files');
      outputError.value = msg;
      log.error('fetchOutputFiles', msg);
    } finally {
      if (outputRequestOwner === owner && !owner.controller.signal.aborted) {
        outputLoading.value = false;
        outputRequestOwner = undefined;
      }
    }
  }

  async function navigateOutput(path: string): Promise<void> {
    if (path !== outputPath.value) clearViewedFile();
    await fetchOutputFiles(path);
  }

  // ── Actions: File Content ──────────────────────────────────

  async function fetchFileContent(path: string): Promise<void> {
    viewerError.value = null;
    viewerState.value = 'idle';
    viewedFile.value = null;
    viewedFilePath.value = path;
    await contentRequest.run((signal) => getFileContent(path, signal), (response: FileContent) => {
      viewedFile.value = response;
      viewerState.value = 'ready';
    }, (err) => {
      const cardMissing = err instanceof OperatorApiError && err.status === 404 && err.data.error === 'workspace_card_not_found';
      const apiMessage = handleApiError(err, 'Failed to fetch file content');
      const msg = cardMissing ? 'Card not found' : apiMessage;
      viewerError.value = msg;
      if (err instanceof OperatorApiError) {
        if (err.status === 403) viewerState.value = 'blocked';
        else if (err.status === 404) viewerState.value = cardMissing ? 'card-missing' : 'missing';
        else if (err.status === 415) viewerState.value = 'binary';
        else if (err.status === 413) viewerState.value = 'too-large';
        else if (err.status === 400) viewerState.value = 'directory';
        else viewerState.value = 'error';
      } else {
        viewerState.value = 'error';
      }
      log.error('fetchFileContent', msg);
    });
  }

  function clearViewedFile(): void {
    contentRequest.cancel();
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
    metaError,
    metaListingAge,
    outputPath,
    outputFiles,
    outputLoading,
    outputError,
    outputListingAge,
    viewedFile,
    viewedFilePath,
    contentLoading,
    viewerError,
    viewerState,
    unauthorized,

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
