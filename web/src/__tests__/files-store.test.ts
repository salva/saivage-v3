/**
 * Focused automated web tests for file store navigation, breadcrumbs,
 * file content loading, JSON/Markdown detection, and error handling.
 *
 * Tests cover:
 *  1. Breadcrumb derivation for metadata root (.saivage/) and output root (.saivage/work/)
 *     at root level, single nested path, and deeply nested path.
 *  2. File content loading — success path sets viewedFile/viewedFilePath.
 *  3. JSON content detection via contentType, +json suffix, and .json extension.
 *  4. Markdown content detection via .md extension and text/markdown contentType.
 *  5. Scoped error handling: list API messages and clearing, generic preview fallback,
 *     and preview clear/recovery state transitions.
 *  6. Store-level navigation actions: navigateMeta, navigateOutput, clearViewedFile.
 *  7. Independent abortable latest-request ownership for metadata and output listings.
 *
 * These tests mock ../api/client so we verify store-side logic without a server.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  listFiles: vi.fn(),
  getFileContent: vi.fn(),
}));

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: loggerMocks.error }),
}));

import { listFiles, getFileContent, OperatorApiError } from '../api/client';
import type { FilesListResponse } from '../api/types';
import { useFileStore } from '../stores/files';

function setupStore() {
  setActivePinia(createPinia());
  return useFileStore();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const mockMetaRootFiles = {
  path: '.saivage',
  files: [
    { name: 'cards', path: '.saivage/cards', type: 'directory' as const, modifiedAt: '2025-01-01T00:00:00Z' },
    { name: 'plan.json', path: '.saivage/plan.json', type: 'file' as const, size: 2048, modifiedAt: '2025-01-01T12:00:00Z' },
    { name: 'config.yaml', path: '.saivage/config.yaml', type: 'file' as const, size: 512, modifiedAt: '2025-01-01T06:00:00Z' },
  ],
};

const mockMetaNestedFiles = {
  path: '.saivage/cards',
  files: [
    { name: 'brief.json', path: '.saivage/cards/11111111-1111-4111-8111-111111111111/brief.json', type: 'file' as const, size: 4096, modifiedAt: '2025-01-02T00:00:00Z' },
    { name: 'review.json', path: '.saivage/cards/22222222-2222-4222-8222-222222222222/review.json', type: 'file' as const, size: 1024, modifiedAt: '2025-01-02T01:00:00Z' },
  ],
};

const mockOutputRootFiles = {
  path: '.saivage/work',
  files: [
    { name: 'logs', path: '.saivage/work/logs', type: 'directory' as const, modifiedAt: '2025-01-01T00:00:00Z' },
    { name: 'output.txt', path: '.saivage/work/output.txt', type: 'file' as const, size: 8192, modifiedAt: '2025-01-01T12:00:00Z' },
  ],
};

const jsonContent = {
  path: '.saivage/plan.json',
  size: 2048,
  contentType: 'application/json',
  content: '{"version":3,"project":"saivage-v3"}',
  redacted: false,
  sensitivity: 'normal',
};

const jsonWithPlusContent = {
  path: '.saivage/report.ld+json',
  size: 512,
  contentType: 'application/ld+json',
  content: '{"@context":"https://schema.org"}',
  redacted: false,
  sensitivity: 'normal',
};

const jsonByExtensionContent = {
  path: '.saivage/work/data.json',
  size: 128,
  contentType: 'text/plain',
  content: '{"key":"value"}',
  redacted: false,
  sensitivity: 'normal',
};

const markdownContent = {
  path: '.saivage/work/report.md',
  size: 1024,
  contentType: 'text/markdown',
  content: '# Report\n## Summary\nSome text.',
  redacted: false,
  sensitivity: 'normal',
};

const markdownByExtensionContent = {
  path: '.saivage/work/readme.md',
  size: 256,
  contentType: 'text/plain',
  content: '# README\nHello world.',
  redacted: false,
  sensitivity: 'normal',
};

const plainTextContent = {
  path: '.saivage/work/output.txt',
  size: 8192,
  contentType: 'text/plain',
  content: 'Line 1\nLine 2\nLine 3',
  redacted: false,
  sensitivity: 'normal',
};

describe('useFileStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('has correct default paths and empty state', () => {
      const store = setupStore();

      expect(store.metaPath).toBe('.saivage');
      expect(store.metaFiles).toEqual([]);
      expect(store.metaLoading).toBe(false);
      expect(store.outputPath).toBe('.saivage/work');
      expect(store.outputFiles).toEqual([]);
      expect(store.outputLoading).toBe(false);
      expect(store.viewedFile).toBeNull();
      expect(store.viewedFilePath).toBe('');
      expect(store.contentLoading).toBe(false);
    });

    it('breadcrumbs at root level contain only the root entry', () => {
      const store = setupStore();

      expect(store.metaBreadcrumbs).toEqual([
        { label: '.saivage', path: '.saivage' },
      ]);

      expect(store.outputBreadcrumbs).toEqual([
        { label: '.saivage/work', path: '.saivage/work' },
      ]);
    });

    it('isJsonContent returns false when no file is viewed', () => {
      const store = setupStore();
      expect(store.isJsonContent).toBe(false);
    });

    it('isMarkdownContent returns false when no file is viewed', () => {
      const store = setupStore();
      expect(store.isMarkdownContent).toBe(false);
    });
  });

  describe('breadcrumbs', () => {
    it('metaBreadcrumbs shows root-only when metaPath is root', () => {
      const store = setupStore();
      expect(store.metaBreadcrumbs).toEqual([
        { label: '.saivage', path: '.saivage' },
      ]);
    });

    it('metaBreadcrumbs shows root + nested path when metaPath is nested', () => {
      const store = setupStore();
      store.$patch({ metaPath: '.saivage/cards/sub/leaf' });

      expect(store.metaBreadcrumbs).toEqual([
        { label: '.saivage', path: '.saivage' },
        { label: 'cards', path: '.saivage/cards' },
        { label: 'sub', path: '.saivage/cards/sub' },
        { label: 'leaf', path: '.saivage/cards/sub/leaf' },
      ]);
    });

    it('metaBreadcrumbs shows single nesting level', () => {
      const store = setupStore();
      store.$patch({ metaPath: '.saivage/cards' });

      expect(store.metaBreadcrumbs).toEqual([
        { label: '.saivage', path: '.saivage' },
        { label: 'cards', path: '.saivage/cards' },
      ]);
    });

    it('metaBreadcrumbs returns root-only when path does not start with root', () => {
      const store = setupStore();
      store.$patch({ metaPath: 'some/other/path' });

      expect(store.metaBreadcrumbs).toEqual([
        { label: '.saivage', path: '.saivage' },
      ]);
    });

    it('outputBreadcrumbs shows root + nested path', () => {
      const store = setupStore();
      store.$patch({ outputPath: '.saivage/work/logs/agent1' });

      expect(store.outputBreadcrumbs).toEqual([
        { label: '.saivage/work', path: '.saivage/work' },
        { label: 'logs', path: '.saivage/work/logs' },
        { label: 'agent1', path: '.saivage/work/logs/agent1' },
      ]);
    });

    it('outputBreadcrumbs at root contains only root entry', () => {
      const store = setupStore();
      expect(store.outputBreadcrumbs).toEqual([
        { label: '.saivage/work', path: '.saivage/work' },
      ]);
    });

    it('breadcrumbs handle trailing slashes in path gracefully', () => {
      const store = setupStore();
      store.$patch({ metaPath: '.saivage/cards/' });

      const crumbs = store.metaBreadcrumbs;
      expect(crumbs).toEqual([
        { label: '.saivage', path: '.saivage' },
        { label: 'cards', path: '.saivage/cards' },
      ]);
    });

    it('metaBreadcrumbs handles path equal to root exactly', () => {
      const store = setupStore();
      store.$patch({ metaPath: '.saivage' });

      expect(store.metaBreadcrumbs).toEqual([
        { label: '.saivage', path: '.saivage' },
      ]);
    });

    it('outputBreadcrumbs handles path equal to root exactly', () => {
      const store = setupStore();
      store.$patch({ outputPath: '.saivage/work' });

      expect(store.outputBreadcrumbs).toEqual([
        { label: '.saivage/work', path: '.saivage/work' },
      ]);
    });
  });

  describe('fetchMetaFiles()', () => {
    it('populates metaFiles and metaPath on success', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockResolvedValue(mockMetaRootFiles);

      await store.fetchMetaFiles();

      expect(store.metaFiles).toEqual(mockMetaRootFiles.files);
      expect(store.metaPath).toBe('.saivage');
      expect(store.metaLoading).toBe(false);
    });

    it('sets loading=true while fetching', async () => {
      const store = setupStore();
      let resolve: (v: typeof mockMetaRootFiles) => void;
      const promise = new Promise<typeof mockMetaRootFiles>((r) => { resolve = r; });
      vi.mocked(listFiles).mockReturnValue(promise);

      const fetchPromise = store.fetchMetaFiles();
      expect(store.metaLoading).toBe(true);

      resolve!(mockMetaRootFiles);
      await fetchPromise;
      expect(store.metaLoading).toBe(false);
    });

    it('sets listError to the API-provided message on failure', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockRejectedValue(new OperatorApiError('files.list', 403, { error: 'Forbidden' }));

      await store.fetchMetaFiles();

      expect(store.metaLoading).toBe(false);
      expect(store.listError).toBe('Forbidden');
    });

    it('accepts optional path parameter overriding metaPath', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockResolvedValue(mockMetaNestedFiles);

      await store.fetchMetaFiles('.saivage/cards');

      expect(listFiles).toHaveBeenCalledWith('.saivage/cards', expect.any(AbortSignal));
      expect(store.metaPath).toBe('.saivage/cards');
      expect(store.metaFiles).toEqual(mockMetaNestedFiles.files);
    });
  });

  describe('fetchOutputFiles()', () => {
    it('populates outputFiles and outputPath on success', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockResolvedValue(mockOutputRootFiles);

      await store.fetchOutputFiles();

      expect(store.outputFiles).toEqual(mockOutputRootFiles.files);
      expect(store.outputPath).toBe('.saivage/work');
      expect(store.outputLoading).toBe(false);
    });
  });

  describe('listing request ownership', () => {
    it('aborts and replaces an older metadata owner and makes its success and finalization inert', async () => {
      const store = setupStore();
      const older = deferred<typeof mockMetaRootFiles>();
      const newer = deferred<typeof mockMetaNestedFiles>();
      const signals: AbortSignal[] = [];
      vi.mocked(listFiles)
        .mockImplementationOnce((_path, signal) => {
          signals.push(signal!);
          return older.promise;
        })
        .mockImplementationOnce((_path, signal) => {
          signals.push(signal!);
          return newer.promise;
        });

      const olderFetch = store.fetchMetaFiles('.saivage');
      const newerFetch = store.fetchMetaFiles('.saivage/cards');

      expect(signals).toHaveLength(2);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);

      older.resolve(mockMetaRootFiles);
      await olderFetch;
      expect(store.metaLoading).toBe(true);
      expect(store.metaFiles).toEqual([]);
      expect(store.metaPath).toBe('.saivage');

      newer.resolve(mockMetaNestedFiles);
      await newerFetch;
      expect(store.metaLoading).toBe(false);
      expect(store.metaFiles).toEqual(mockMetaNestedFiles.files);
      expect(store.metaPath).toBe('.saivage/cards');
    });

    it('makes an older metadata failure inert while the current owner controls shared state and logging', async () => {
      const store = setupStore();
      const older = deferred<FilesListResponse>();
      const newer = deferred<typeof mockMetaNestedFiles>();
      vi.mocked(listFiles)
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise);

      const olderFetch = store.fetchMetaFiles('.saivage');
      const newerFetch = store.fetchMetaFiles('.saivage/cards');
      older.reject(new OperatorApiError('files.list', 401, { error: 'Unauthorized', statusCode: 401 }));
      await olderFetch;

      expect(store.metaLoading).toBe(true);
      expect(store.listError).toBeNull();
      expect(store.unauthorized).toBe(false);
      expect(loggerMocks.error).not.toHaveBeenCalled();

      newer.reject(new OperatorApiError('files.list', 403, { error: 'Current failure' }));
      await newerFetch;
      expect(store.metaLoading).toBe(false);
      expect(store.listError).toBe('Current failure');
      expect(store.unauthorized).toBe(false);
      expect(loggerMocks.error).toHaveBeenCalledWith('fetchMetaFiles', 'Current failure');
    });

    it('keeps metadata and output owners independent when both listings run concurrently', async () => {
      const store = setupStore();
      const olderMeta = deferred<typeof mockMetaRootFiles>();
      const output = deferred<typeof mockOutputRootFiles>();
      const newerMeta = deferred<typeof mockMetaNestedFiles>();
      const signals: AbortSignal[] = [];
      vi.mocked(listFiles).mockImplementation((_path, signal) => {
        signals.push(signal!);
        if (signals.length === 1) return olderMeta.promise;
        if (signals.length === 2) return output.promise;
        return newerMeta.promise;
      });

      const olderMetaFetch = store.fetchMetaFiles();
      const outputFetch = store.fetchOutputFiles();
      expect(signals[0]?.aborted).toBe(false);
      expect(signals[1]?.aborted).toBe(false);

      const newerMetaFetch = store.fetchMetaFiles('.saivage/cards');
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      expect(signals[2]?.aborted).toBe(false);

      output.resolve(mockOutputRootFiles);
      newerMeta.resolve(mockMetaNestedFiles);
      olderMeta.resolve(mockMetaRootFiles);
      await Promise.all([olderMetaFetch, outputFetch, newerMetaFetch]);

      expect(store.outputFiles).toEqual(mockOutputRootFiles.files);
      expect(store.metaFiles).toEqual(mockMetaNestedFiles.files);
      expect(store.outputLoading).toBe(false);
      expect(store.metaLoading).toBe(false);
    });

    it('lets only the current listing success update Files freshness', async () => {
      vi.useFakeTimers();
      const store = setupStore();
      const older = deferred<typeof mockMetaRootFiles>();
      const newer = deferred<typeof mockMetaNestedFiles>();
      vi.mocked(listFiles)
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise);

      try {
        const olderFetch = store.fetchMetaFiles();
        const newerFetch = store.fetchMetaFiles('.saivage/cards');
        newer.resolve(mockMetaNestedFiles);
        await newerFetch;

        await vi.advanceTimersByTimeAsync(20_000);
        older.resolve(mockMetaRootFiles);
        await olderFetch;
        await vi.advanceTimersByTimeAsync(10_000);

        expect(store.isStale).toBe(true);
      } finally {
        store.$dispose();
        vi.useRealTimers();
      }
    });

    it('aborts both independent listing owners on store disposal', () => {
      const store = setupStore();
      const signals: AbortSignal[] = [];
      vi.mocked(listFiles).mockImplementation((_path, signal) => {
        signals.push(signal!);
        return new Promise<FilesListResponse>(() => {});
      });

      void store.fetchMetaFiles();
      void store.fetchOutputFiles();
      expect(signals.every((signal) => !signal.aborted)).toBe(true);

      store.$dispose();

      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    });
  });

  describe('navigateMeta()', () => {
    it('sets metaPath and fetches files for the given path', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockResolvedValue(mockMetaNestedFiles);

      await store.navigateMeta('.saivage/cards');

      expect(store.metaPath).toBe('.saivage/cards');
      expect(listFiles).toHaveBeenCalledWith('.saivage/cards', expect.any(AbortSignal));
      expect(store.metaFiles).toEqual(mockMetaNestedFiles.files);
    });

    it('updates breadcrumbs after navigation', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockResolvedValue(mockMetaNestedFiles);

      await store.navigateMeta('.saivage/cards');

      expect(store.metaBreadcrumbs).toEqual([
        { label: '.saivage', path: '.saivage' },
        { label: 'cards', path: '.saivage/cards' },
      ]);
    });
  });

  describe('navigateOutput()', () => {
    it('sets outputPath and fetches files', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockResolvedValue(mockOutputRootFiles);

      await store.navigateOutput('.saivage/work');

      expect(store.outputPath).toBe('.saivage/work');
      expect(listFiles).toHaveBeenCalledWith('.saivage/work', expect.any(AbortSignal));
    });
  });

  describe('fetchFileContent()', () => {
    it('sets viewedFile and viewedFilePath on success', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockResolvedValue(jsonContent);

      await store.fetchFileContent('.saivage/plan.json');

      expect(store.viewedFile).toEqual(jsonContent);
      expect(store.viewedFilePath).toBe('.saivage/plan.json');
      expect(store.contentLoading).toBe(false);
    });

    it('sets contentLoading=true while fetching', async () => {
      const store = setupStore();
      let resolve: (v: typeof jsonContent) => void;
      const promise = new Promise<typeof jsonContent>((r) => { resolve = r; });
      vi.mocked(getFileContent).mockReturnValue(promise);

      const fetchPromise = store.fetchFileContent('.saivage/plan.json');
      expect(store.contentLoading).toBe(true);

      resolve!(jsonContent);
      await fetchPromise;
      expect(store.contentLoading).toBe(false);
    });

    it('sets the generic viewer fallback and error state on generic failure', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockRejectedValue(new Error('Fetch failed'));

      await store.fetchFileContent('.saivage/nonexistent.txt');

      expect(store.viewerError).toBe('Failed to fetch file content');
      expect(store.viewerState).toBe('error');
      expect(store.contentLoading).toBe(false);
      expect(store.viewedFile).toBeNull();
      expect(store.viewedFilePath).toBe('.saivage/nonexistent.txt');
    });

    it('replaces the stale deadline with the latest accepted Files REST completion', async () => {
      vi.useFakeTimers();
      const startedAt = new Date('2026-08-11T12:00:00.000Z');
      vi.setSystemTime(startedAt);
      const store = setupStore();

      try {
        vi.mocked(getFileContent).mockResolvedValue(jsonContent);
        await store.fetchFileContent('.saivage/plan.json');

        expect(store.isStale).toBe(false);

        await vi.advanceTimersByTimeAsync(20_000);
        vi.mocked(listFiles).mockResolvedValue(mockMetaRootFiles);
        await store.fetchMetaFiles();

        expect(store.isStale).toBe(false);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(store.isStale).toBe(false);

        await vi.advanceTimersByTimeAsync(20_000);
        expect(store.isStale).toBe(true);
      } finally {
        store.$dispose();
        vi.useRealTimers();
      }
    });
  });

  describe('clearViewedFile()', () => {
    it('resets viewedFile and viewedFilePath', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockResolvedValue(jsonContent);
      await store.fetchFileContent('.saivage/plan.json');

      expect(store.viewedFile).not.toBeNull();
      expect(store.viewedFilePath).toBe('.saivage/plan.json');

      store.clearViewedFile();

      expect(store.viewedFile).toBeNull();
      expect(store.viewedFilePath).toBe('');
    });

    it('is safe to call when nothing is viewed', () => {
      const store = setupStore();

      expect(() => store.clearViewedFile()).not.toThrow();
      expect(store.viewedFile).toBeNull();
      expect(store.viewedFilePath).toBe('');
    });
  });

  describe('isJsonContent', () => {
    it('detects JSON via application/json contentType', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockResolvedValue(jsonContent);

      await store.fetchFileContent('.saivage/plan.json');

      expect(store.isJsonContent).toBe(true);
    });

    it('detects JSON via +json suffix in contentType', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockResolvedValue(jsonWithPlusContent);

      await store.fetchFileContent('.saivage/report.ld+json');

      expect(store.isJsonContent).toBe(true);
    });

    it('detects JSON via .json file extension (even with text/plain contentType)', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockResolvedValue(jsonByExtensionContent);

      await store.fetchFileContent('.saivage/work/data.json');

      expect(store.isJsonContent).toBe(true);
    });

    it('returns false for plain text content', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockResolvedValue(plainTextContent);

      await store.fetchFileContent('.saivage/work/output.txt');

      expect(store.isJsonContent).toBe(false);
    });

    it('returns false for Markdown content', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockResolvedValue(markdownContent);

      await store.fetchFileContent('.saivage/work/report.md');

      expect(store.isJsonContent).toBe(false);
    });

    it('returns false when no file is viewed', () => {
      const store = setupStore();
      expect(store.isJsonContent).toBe(false);
    });
  });

  describe('isMarkdownContent', () => {
    it('detects Markdown via .md extension', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockResolvedValue(markdownByExtensionContent);

      await store.fetchFileContent('.saivage/work/readme.md');

      expect(store.isMarkdownContent).toBe(true);
    });

    it('detects Markdown via text/markdown contentType', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockResolvedValue(markdownContent);

      await store.fetchFileContent('.saivage/work/report.md');

      expect(store.isMarkdownContent).toBe(true);
    });

    it('returns false for JSON content', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockResolvedValue(jsonContent);

      await store.fetchFileContent('.saivage/plan.json');

      expect(store.isMarkdownContent).toBe(false);
    });

    it('returns false for plain text content', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockResolvedValue(plainTextContent);

      await store.fetchFileContent('.saivage/work/output.txt');

      expect(store.isMarkdownContent).toBe(false);
    });

    it('returns false when no file is viewed', () => {
      const store = setupStore();
      expect(store.isMarkdownContent).toBe(false);
    });

    it('detects markdown even when contentType is missing (only .md extension)', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockResolvedValue({
        path: '.saivage/notes.md',
        size: 100,
        contentType: '',
        content: '# Notes',
        redacted: false,
        sensitivity: 'normal',
      });

      await store.fetchFileContent('.saivage/notes.md');

      expect(store.isMarkdownContent).toBe(true);
    });
  });

  describe('scoped error handling', () => {
    it('clears listError when a subsequent list call succeeds', async () => {
      const store = setupStore();

      vi.mocked(listFiles).mockRejectedValueOnce(new Error('Temporary failure'));
      await store.fetchMetaFiles();
      expect(store.listError).toBe('Failed to list metadata files');

      vi.mocked(listFiles).mockResolvedValueOnce(mockMetaRootFiles);
      await store.fetchMetaFiles();
      expect(store.listError).toBeNull();
      expect(store.metaFiles).toEqual(mockMetaRootFiles.files);
    });
  });

  describe('deep breadcrumb paths', () => {
    it('handles deeply nested meta path', () => {
      const store = setupStore();
      store.$patch({ metaPath: '.saivage/a/b/c/d/e' });

      expect(store.metaBreadcrumbs).toEqual([
        { label: '.saivage', path: '.saivage' },
        { label: 'a', path: '.saivage/a' },
        { label: 'b', path: '.saivage/a/b' },
        { label: 'c', path: '.saivage/a/b/c' },
        { label: 'd', path: '.saivage/a/b/c/d' },
        { label: 'e', path: '.saivage/a/b/c/d/e' },
      ]);
    });

    it('handles deeply nested output path', () => {
      const store = setupStore();
      store.$patch({ outputPath: '.saivage/work/x/y/z' });

      expect(store.outputBreadcrumbs).toEqual([
        { label: '.saivage/work', path: '.saivage/work' },
        { label: 'x', path: '.saivage/work/x' },
        { label: 'y', path: '.saivage/work/x/y' },
        { label: 'z', path: '.saivage/work/x/y/z' },
      ]);
    });
  });

  describe('file content recovery path (fail → clearViewedFile → success)', () => {
    it('clearViewedFile resets viewer error/state and a subsequent fetch reaches ready state', async () => {
      const store = setupStore();

      vi.mocked(getFileContent).mockRejectedValueOnce(
        new OperatorApiError('files.content', 500, { error: 'InternalServerError', message: 'Internal server error' }),
      );
      await store.fetchFileContent('.saivage/bad.json');

      expect(store.viewerError).toBe('Internal server error');
      expect(store.viewerState).toBe('error');
      expect(store.viewedFile).toBeNull();

      store.clearViewedFile();
      expect(store.viewerError).toBeNull();
      expect(store.viewerState).toBe('idle');
      expect(store.viewedFile).toBeNull();
      expect(store.viewedFilePath).toBe('');

      vi.mocked(getFileContent).mockResolvedValueOnce(markdownContent);
      await store.fetchFileContent('.saivage/work/report.md');

      expect(store.viewerError).toBeNull();
      expect(store.viewerState).toBe('ready');
      expect(store.viewedFile).toEqual(markdownContent);
      expect(store.viewedFilePath).toBe('.saivage/work/report.md');
    });
  });

});
