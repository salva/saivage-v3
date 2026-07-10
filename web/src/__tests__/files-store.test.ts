/**
 * Focused automated web tests for file store navigation, breadcrumbs,
 * file content loading, JSON/Markdown detection, and error handling.
 *
 * Tests cover:
 *  1. Breadcrumb derivation for metadata root (.saivage/) and output root (.saivage/work/)
 *     at root level, single nested path, and deeply nested path.
 *  2. File content loading — success path sets viewedFile/viewedFilePath, clears error.
 *  3. JSON content detection via contentType, +json suffix, and .json extension.
 *  4. Markdown content detection via .md extension and text/markdown contentType.
 *  5. Protected-content / error handling: listFiles failure, getFileContent failure,
 *     ApiError-specific message extraction, and generic Error fallback.
 *  6. Store-level navigation actions: navigateMeta, navigateOutput, navigateMetaUp,
 *     navigateOutputUp, clearViewedFile.
 *
 * These tests mock ../api/client so we verify store-side logic without a server.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../api/client', () => ({
  listFiles: vi.fn(),
  getFileContent: vi.fn(),
  ApiError: class extends Error {
    status: number;
    body: Record<string, unknown>;
    constructor(status: number, message: string, body: Record<string, unknown> = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
    get isUnauthorized(): boolean { return this.status === 401; }
    get isNotFound(): boolean { return this.status === 404; }
  },
}));

import { listFiles, getFileContent, ApiError } from '../api/client';
import { useFileStore } from '../stores/files';

function setupStore() {
  setActivePinia(createPinia());
  return useFileStore();
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
    { name: 'card-001.json', path: '.saivage/cards/card-001.json', type: 'file' as const, size: 4096, modifiedAt: '2025-01-02T00:00:00Z' },
    { name: 'card-002.json', path: '.saivage/cards/card-002.json', type: 'file' as const, size: 1024, modifiedAt: '2025-01-02T01:00:00Z' },
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
      expect(store.error).toBeNull();
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
      expect(store.error).toBeNull();
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

    it('sets error on ApiError failure', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockRejectedValue(new ApiError(403, 'Forbidden', {}));

      await store.fetchMetaFiles();

      expect(store.metaLoading).toBe(false);
      expect(store.error).toBe('Forbidden');
    });

    it('sets error on generic Error failure', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockRejectedValue(new Error('Network error'));

      await store.fetchMetaFiles();

      expect(store.metaLoading).toBe(false);
      expect(store.error).toBe('Failed to list metadata files');
    });

    it('accepts optional path parameter overriding metaPath', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockResolvedValue(mockMetaNestedFiles);

      await store.fetchMetaFiles('.saivage/cards');

      expect(listFiles).toHaveBeenCalledWith('.saivage/cards');
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
      expect(store.error).toBeNull();
    });

    it('sets error on failure', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockRejectedValue(new ApiError(404, 'Not found', {}));

      await store.fetchOutputFiles();

      expect(store.outputLoading).toBe(false);
      expect(store.error).toBe('Not found');
    });
  });

  describe('navigateMeta()', () => {
    it('sets metaPath and fetches files for the given path', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockResolvedValue(mockMetaNestedFiles);

      await store.navigateMeta('.saivage/cards');

      expect(store.metaPath).toBe('.saivage/cards');
      expect(listFiles).toHaveBeenCalledWith('.saivage/cards');
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

    it('propagates errors from fetchMetaFiles', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockRejectedValue(new ApiError(500, 'Server error', {}));

      await store.navigateMeta('.saivage/cards');

      expect(store.error).toBe('Server error');
    });
  });

  describe('navigateMetaUp()', () => {
    it('goes to parent directory from nested path', async () => {
      const store = setupStore();
      store.$patch({ metaPath: '.saivage/cards/sub' });
      vi.mocked(listFiles).mockResolvedValue(mockMetaNestedFiles);

      await store.navigateMetaUp();

      expect(store.metaPath).toBe('.saivage/cards');
      expect(listFiles).toHaveBeenCalledWith('.saivage/cards');
    });

    it('does nothing when already at root', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockResolvedValue(mockMetaRootFiles);

      await store.navigateMetaUp();

      expect(listFiles).not.toHaveBeenCalled();
    });

    it('navigates from single-level nested back to root', async () => {
      const store = setupStore();
      store.$patch({ metaPath: '.saivage/cards' });
      vi.mocked(listFiles).mockResolvedValue(mockMetaRootFiles);

      await store.navigateMetaUp();

      expect(store.metaPath).toBe('.saivage');
      expect(listFiles).toHaveBeenCalledWith('.saivage');
    });
  });

  describe('navigateOutput()', () => {
    it('sets outputPath and fetches files', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockResolvedValue(mockOutputRootFiles);

      await store.navigateOutput('.saivage/work');

      expect(store.outputPath).toBe('.saivage/work');
      expect(listFiles).toHaveBeenCalledWith('.saivage/work');
    });
  });

  describe('navigateOutputUp()', () => {
    it('goes to parent from nested output path', async () => {
      const store = setupStore();
      store.$patch({ outputPath: '.saivage/work/logs' });
      vi.mocked(listFiles).mockResolvedValue(mockOutputRootFiles);

      await store.navigateOutputUp();

      expect(store.outputPath).toBe('.saivage/work');
      expect(listFiles).toHaveBeenCalledWith('.saivage/work');
    });

    it('does nothing when at output root', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockResolvedValue(mockOutputRootFiles);

      await store.navigateOutputUp();

      expect(listFiles).not.toHaveBeenCalled();
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
      expect(store.error).toBeNull();
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

    it('sets error on ApiError failure', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockRejectedValue(
        new ApiError(403, 'Protected content — requires supervisor approval', { code: 'PROTECTED' }),
      );

      await store.fetchFileContent('.saivage/work/output/bad.txt');

      expect(store.error).toBe('Protected content — requires supervisor approval');
      expect(store.contentLoading).toBe(false);
      expect(store.viewedFile).toBeNull();
      expect(store.viewedFilePath).toBe('.saivage/work/output/bad.txt');
    });

    it('sets error on generic Error failure', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockRejectedValue(new Error('Fetch failed'));

      await store.fetchFileContent('.saivage/nonexistent.txt');

      expect(store.error).toBe('Failed to fetch file content');
      expect(store.contentLoading).toBe(false);
      expect(store.viewedFile).toBeNull();
      expect(store.viewedFilePath).toBe('.saivage/nonexistent.txt');
    });

    it('clears previous error on successful fetch', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockRejectedValueOnce(new Error('First fail'));
      await store.fetchFileContent('.saivage/fail.txt');
      expect(store.error).toBe('Failed to fetch file content');

      vi.mocked(getFileContent).mockResolvedValueOnce(jsonContent);
      await store.fetchFileContent('.saivage/plan.json');

      expect(store.error).toBeNull();
      expect(store.viewedFile).toEqual(jsonContent);
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

  describe('error handling — protected content and failed fetch', () => {
    it('sets error message from ApiError with protected content message in listFiles', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockRejectedValue(
        new ApiError(403, 'Protected content — access denied', { code: 'ACCESS_DENIED' }),
      );

      await store.fetchMetaFiles('.saivage/protected');

      expect(store.error).toBe('Protected content — access denied');
      expect(store.metaFiles).toEqual([]);
    });

    it('sets error message from ApiError with protected content message in getFileContent', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockRejectedValue(
        new ApiError(403, 'This file is blocked by content supervisor', {}),
      );

      await store.fetchFileContent('.saivage/work/output/blocked.json');

      expect(store.error).toBe('This file is blocked by content supervisor');
      expect(store.viewedFile).toBeNull();
      expect(store.contentLoading).toBe(false);
    });

    it('handles 404 not-found errors from getFileContent', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockRejectedValue(
        new ApiError(404, 'File not found at path', {}),
      );

      await store.fetchFileContent('.saivage/missing.txt');

      expect(store.error).toBe('File not found at path');
      expect(store.viewedFile).toBeNull();
    });

    it('handles 401 unauthorized errors from listFiles', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockRejectedValue(
        new ApiError(401, 'Unauthorized — valid API token required', {}),
      );

      await store.fetchMetaFiles();

      expect(store.error).toBe('Unauthorized — valid API token required');
      expect(store.metaLoading).toBe(false);
    });

    it('handles 500 server errors from listFiles', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockRejectedValue(
        new ApiError(500, 'Internal server error', {}),
      );

      await store.fetchMetaFiles();

      expect(store.error).toBe('Internal server error');
    });

    it('handles network failure (non-ApiError) in fetchOutputFiles', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockRejectedValue(new TypeError('Failed to fetch'));

      await store.fetchOutputFiles();

      expect(store.error).toBe('Failed to list output files');
    });

    it('handles network failure (non-ApiError) in fetchFileContent', async () => {
      const store = setupStore();
      vi.mocked(getFileContent).mockRejectedValue(new TypeError('NetworkError'));

      await store.fetchFileContent('.saivage/some.txt');

      expect(store.error).toBe('Failed to fetch file content');
    });

    it('error is cleared when a subsequent call succeeds', async () => {
      const store = setupStore();

      vi.mocked(listFiles).mockRejectedValueOnce(new Error('Temporary failure'));
      await store.fetchMetaFiles();
      expect(store.error).toBe('Failed to list metadata files');

      vi.mocked(listFiles).mockResolvedValueOnce(mockMetaRootFiles);
      await store.fetchMetaFiles();
      expect(store.error).toBeNull();
      expect(store.metaFiles).toEqual(mockMetaRootFiles.files);
    });
  });

  describe('navigation error propagation', () => {
    it('navigateMeta sets error on failure', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockRejectedValue(new ApiError(500, 'Boom', {}));

      await store.navigateMeta('.saivage/bad');

      expect(store.error).toBe('Boom');
    });

    it('navigateOutput sets error on failure', async () => {
      const store = setupStore();
      vi.mocked(listFiles).mockRejectedValue(new Error('Network down'));

      await store.navigateOutput('.saivage/work/bad');

      expect(store.error).toBe('Failed to list output files');
    });

    it('navigateMetaUp sets error when parent fetch fails', async () => {
      const store = setupStore();
      store.$patch({ metaPath: '.saivage/cards' });
      vi.mocked(listFiles).mockRejectedValue(new ApiError(500, 'Parent failed', {}));

      await store.navigateMetaUp();

      expect(store.error).toBe('Parent failed');
      expect(store.metaPath).toBe('.saivage');
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
    it('recovers after failed fetch: clearViewedFile resets viewer, subsequent fetch succeeds with clean state', async () => {
      const store = setupStore();

      vi.mocked(getFileContent).mockRejectedValueOnce(
        new ApiError(403, 'Content blocked by supervisor', { code: 'BLOCKED' }),
      );
      await store.fetchFileContent('.saivage/work/output/bad.txt');

      expect(store.error).toBe('Content blocked by supervisor');
      expect(store.viewedFile).toBeNull();
      expect(store.viewedFilePath).toBe('.saivage/work/output/bad.txt');
      expect(store.contentLoading).toBe(false);

      store.clearViewedFile();

      expect(store.viewedFile).toBeNull();
      expect(store.viewedFilePath).toBe('');

      vi.mocked(getFileContent).mockResolvedValueOnce(jsonContent);
      await store.fetchFileContent('.saivage/plan.json');

      expect(store.viewedFile).toEqual(jsonContent);
      expect(store.viewedFilePath).toBe('.saivage/plan.json');
      expect(store.error).toBeNull();
      expect(store.contentLoading).toBe(false);
    });

    it('clearViewedFile clears viewer-specific error state but not shared fetch error until next fetch', async () => {
      const store = setupStore();

      vi.mocked(getFileContent).mockRejectedValueOnce(
        new ApiError(500, 'Server error', {}),
      );
      await store.fetchFileContent('.saivage/bad.json');

      expect(store.error).toBe('Server error');
      expect(store.viewerError).toBe('Server error');
      expect(store.viewedFile).toBeNull();

      store.clearViewedFile();
      expect(store.error).toBe('Server error');
      expect(store.viewerError).toBeNull();
      expect(store.viewedFile).toBeNull();
      expect(store.viewedFilePath).toBe('');

      vi.mocked(getFileContent).mockResolvedValueOnce(markdownContent);
      await store.fetchFileContent('.saivage/work/report.md');

      expect(store.error).toBeNull();
      expect(store.viewedFile).toEqual(markdownContent);
      expect(store.viewedFilePath).toBe('.saivage/work/report.md');
    });
  });

  describe('refetch()', () => {
    it('refreshes current views through the sync refetch hook', async () => {
      const store = setupStore();
      store.viewedFilePath = '.saivage/plan.json';
      vi.mocked(listFiles)
        .mockResolvedValueOnce(mockMetaRootFiles)
        .mockResolvedValueOnce(mockOutputRootFiles);
      vi.mocked(getFileContent).mockResolvedValueOnce(jsonContent);

      await store.refetch();

      expect(listFiles).toHaveBeenNthCalledWith(1, '.saivage');
      expect(listFiles).toHaveBeenNthCalledWith(2, '.saivage/work');
      expect(getFileContent).toHaveBeenCalledWith('.saivage/plan.json');
    });
  });
});
