import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import FilesView from '../views/FilesView.vue';
import { useFileStore } from '../stores/files';
import type { FileContent, FilesListResponse } from '../api/types';

const syncMocks = vi.hoisted(() => ({
  registerResource: vi.fn(),
  unregisterFiles: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    listFiles: vi.fn(),
    getFileContent: vi.fn(),
  };
});

vi.mock('../stores/sync', () => ({
  useSyncStore: () => ({
    registerResource: syncMocks.registerResource,
  }),
}));

import { listFiles, getFileContent, OperatorApiError } from '../api/client';

const mockMetaRootFiles: FilesListResponse = {
  path: '.saivage',
  files: [
    { name: 'cards', path: '.saivage/cards', type: 'directory', modifiedAt: '2025-06-01T00:00:00Z' },
    { name: 'plan.json', path: '.saivage/plan.json', type: 'file', size: 2048, modifiedAt: '2025-06-01T12:00:00Z' },
  ],
};

const mockOutputRootFiles: FilesListResponse = {
  path: '.saivage/work',
  files: [
    { name: 'logs', path: '.saivage/work/logs', type: 'directory', modifiedAt: '2025-06-01T00:00:00Z' },
    { name: 'output.txt', path: '.saivage/work/output.txt', type: 'file', size: 8192, modifiedAt: '2025-06-01T12:00:00Z' },
  ],
};

const jsonContent: FileContent = {
  path: '.saivage/plan.json',
  size: 2048,
  contentType: 'application/json',
  content: '{"version":3,"project":"saivage-v3"}',
  redacted: false,
  sensitivity: 'normal',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [{ path: '/files', name: 'files', component: FilesView }],
  });
}

async function mountFilesView(opts?: {
  initialRoute?: string;
  listFilesImpl?: (path?: string) => Promise<FilesListResponse>;
  configureStore?: (store: ReturnType<typeof useFileStore>) => void;
  errorHandler?: (error: unknown) => void;
}) {
  vi.mocked(listFiles).mockImplementation(opts?.listFilesImpl ?? (async (path?: string) => {
    if (path === '.saivage/work') return mockOutputRootFiles;
    if (path === '.saivage') return mockMetaRootFiles;
    if (path === '.saivage/work/logs') return { path: '.saivage/work/logs', files: [] };
    return { path: path ?? '', files: [] };
  }));

  const pinia = createPinia();
  const fileStore = useFileStore(pinia);
  opts?.configureStore?.(fileStore);
  const router = makeRouter();
  await router.push(opts?.initialRoute ?? '/files');
  await router.isReady();

  const wrapper = mount(FilesView, {
    global: { plugins: [pinia, router], config: { errorHandler: opts?.errorHandler } },
  });
  await flushPromises();
  return { wrapper, router, fileStore };
}

describe('FilesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncMocks.registerResource.mockReturnValue(syncMocks.unregisterFiles);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders both Metadata and Output panels', async () => {
    const { wrapper } = await mountFilesView();
    expect(wrapper.find('[data-testid="route-files"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="files-canonical-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="route-files"]').text()).toContain('Metadata');
  });

  it.each([
    { root: 'meta', path: '.saivage', hiddenPath: '.saivage/work' },
    { root: 'output', path: '.saivage/work', hiddenPath: '.saivage' },
  ])('refetches only the $root root selected when the callback is invoked', async ({ root, path, hiddenPath }) => {
    const initialRoot = root === 'meta' ? 'output' : 'meta';
    const initialPath = initialRoot === 'meta' ? '.saivage' : '.saivage/work';
    const { wrapper, router } = await mountFilesView({
      initialRoute: `/files?root=${initialRoot}&path=${encodeURIComponent(initialPath)}`,
    });
    const refetch = syncMocks.registerResource.mock.calls[0]![0].refetch as () => Promise<void>;

    vi.mocked(listFiles).mockClear();
    await router.push({ name: 'files', query: { root, path } });
    await flushPromises();
    vi.mocked(listFiles).mockClear();

    await refetch();

    expect(listFiles).toHaveBeenCalledWith(path, expect.any(AbortSignal));
    expect(vi.mocked(listFiles).mock.calls.map(([calledPath]) => calledPath)).not.toContain(hiddenPath);
    wrapper.unmount();
  });

  it('refetches the represented parent and preview on reconnect from a direct deep-file route', async () => {
    const filePath = '.saivage/logs/app.jsonl';
    const parentPath = '.saivage/logs';
    vi.mocked(getFileContent).mockResolvedValue({
      path: filePath,
      size: 128,
      contentType: 'application/x-ndjson',
      content: '{"message":"ready"}\n',
      redacted: false,
      sensitivity: 'normal',
    });
    const { wrapper } = await mountFilesView({
      initialRoute: `/files?root=meta&path=${encodeURIComponent(filePath)}`,
      listFilesImpl: async (path?: string) => {
        if (path === filePath) {
          throw new OperatorApiError('files.list', 400, { error: 'ValidationError', message: 'Path is not a directory', issues: [] });
        }
        if (path === parentPath) {
          return {
            path: parentPath,
            files: [{ name: 'app.jsonl', path: filePath, type: 'file', size: 128, modifiedAt: '2025-06-01T12:00:00Z' }],
          };
        }
        if (path === '.saivage/work') return mockOutputRootFiles;
        return { path: path ?? '', files: [] };
      },
    });
    const refetch = syncMocks.registerResource.mock.calls[0]![0].refetch as () => Promise<void>;

    vi.mocked(listFiles).mockClear();
    vi.mocked(getFileContent).mockClear();
    await refetch();

    expect(listFiles).toHaveBeenCalledWith(parentPath, expect.any(AbortSignal));
    expect(getFileContent).toHaveBeenCalledWith(filePath);
    expect(vi.mocked(listFiles).mock.calls.map(([calledPath]) => calledPath)).not.toContain('.saivage/work');
    expect(vi.mocked(listFiles).mock.calls.map(([calledPath]) => calledPath)).not.toContain(filePath);
    wrapper.unmount();
  });

  it('keeps a pending deep-file route authoritative when connected registration refetches', async () => {
    const filePath = '.saivage/logs/app.jsonl';
    const parentPath = '.saivage/logs';
    const firstDirectoryRequest = deferred<FilesListResponse>();
    vi.mocked(getFileContent).mockResolvedValue({
      path: filePath,
      size: 128,
      contentType: 'application/x-ndjson',
      content: '{"message":"ready"}\n',
      redacted: false,
      sensitivity: 'normal',
    });

    const { wrapper } = await mountFilesView({
      initialRoute: `/files?root=meta&path=${encodeURIComponent(filePath)}`,
      listFilesImpl: async (path?: string) => {
        if (path === filePath) return firstDirectoryRequest.promise;
        if (path === parentPath) {
          return {
            path: parentPath,
            files: [{ name: 'app.jsonl', path: filePath, type: 'file', size: 128, modifiedAt: '2025-06-01T12:00:00Z' }],
          };
        }
        if (path === '.saivage') return mockMetaRootFiles;
        return { path: path ?? '', files: [] };
      },
    });
    const firstSignal = vi.mocked(listFiles).mock.calls[0]![1] as AbortSignal;
    const connectedRefetch = syncMocks.registerResource.mock.calls[0]![0].refetch as () => Promise<void>;

    const refetchPromise = connectedRefetch();
    await flushPromises();
    firstDirectoryRequest.reject(new OperatorApiError('files.list', 400, {
      error: 'ValidationError',
      message: 'Path is not a directory',
      issues: [],
    }));
    await refetchPromise;
    await flushPromises();

    expect.soft(firstSignal.aborted).toBe(false);
    expect.soft(vi.mocked(listFiles).mock.calls.map(([path]) => path)).toEqual([filePath, parentPath]);
    expect.soft(getFileContent).toHaveBeenCalledOnce();
    expect.soft(getFileContent).toHaveBeenCalledWith(filePath);
    expect.soft(wrapper.find('[data-testid="files-viewer"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('lists a clicked directory exactly once through route navigation', async () => {
    const { wrapper, router } = await mountFilesView();
    const push = vi.spyOn(router, 'push');
    vi.mocked(listFiles).mockClear();

    await wrapper.findAll('.file-list')[0].findAll('.file-entry')[0].trigger('click');
    await flushPromises();

    const targetCalls = vi.mocked(listFiles).mock.calls.filter(([path]) => path === '.saivage/cards');
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ name: 'files', query: { root: 'meta', path: '.saivage/cards' } });
    expect(targetCalls).toHaveLength(1);
    expect((targetCalls[0]![1] as AbortSignal).aborted).toBe(false);
    wrapper.unmount();
  });

  it('stops a superseded initial file sequence before its parent fallback and preview', async () => {
    const oldFilePath = '.saivage/logs/old.jsonl';
    const oldDirectoryRequest = deferred<FilesListResponse>();
    vi.mocked(getFileContent).mockResolvedValue(jsonContent);
    const { wrapper, router } = await mountFilesView({
      initialRoute: `/files?root=meta&path=${encodeURIComponent(oldFilePath)}`,
      listFilesImpl: async (path?: string) => {
        if (path === oldFilePath) return oldDirectoryRequest.promise;
        if (path === '.saivage/cards') return { path: '.saivage/cards', files: [] };
        return { path: path ?? '', files: [] };
      },
    });
    const oldSignal = vi.mocked(listFiles).mock.calls[0]![1] as AbortSignal;

    await router.push({ name: 'files', query: { root: 'meta', path: '.saivage/cards' } });
    await flushPromises();
    oldDirectoryRequest.reject(new OperatorApiError('files.list', 400, {
      error: 'ValidationError',
      message: 'Path is not a directory',
      issues: [],
    }));
    await flushPromises();

    expect(oldSignal.aborted).toBe(true);
    expect(vi.mocked(listFiles).mock.calls.map(([path]) => path)).toEqual([oldFilePath, '.saivage/cards']);
    expect(getFileContent).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="files-viewer"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('stops an unmounted initial file sequence before its parent fallback and preview', async () => {
    const filePath = '.saivage/logs/old.jsonl';
    const directoryRequest = deferred<FilesListResponse>();
    const { wrapper } = await mountFilesView({
      initialRoute: `/files?root=meta&path=${encodeURIComponent(filePath)}`,
      listFilesImpl: async (path?: string) => {
        if (path === filePath) return directoryRequest.promise;
        return { path: path ?? '', files: [] };
      },
    });

    wrapper.unmount();
    directoryRequest.reject(new OperatorApiError('files.list', 400, {
      error: 'ValidationError',
      message: 'Path is not a directory',
      issues: [],
    }));
    await flushPromises();

    expect(vi.mocked(listFiles).mock.calls.map(([path]) => path)).toEqual([filePath]);
    expect(getFileContent).not.toHaveBeenCalled();
    expect(syncMocks.unregisterFiles).toHaveBeenCalledOnce();
  });

  it('does not launch an old preview when refetch completion follows a new route', async () => {
    const filePath = '.saivage/logs/app.jsonl';
    const parentPath = '.saivage/logs';
    const refetchDirectoryRequest = deferred<FilesListResponse>();
    const parentListing: FilesListResponse = {
      path: parentPath,
      files: [{ name: 'app.jsonl', path: filePath, type: 'file', size: 128, modifiedAt: '2025-06-01T12:00:00Z' }],
    };
    vi.mocked(getFileContent).mockResolvedValue({
      path: filePath,
      size: 128,
      contentType: 'application/x-ndjson',
      content: '{"message":"ready"}\n',
      redacted: false,
      sensitivity: 'normal',
    });
    let parentRequestCount = 0;
    const { wrapper, router } = await mountFilesView({
      initialRoute: `/files?root=meta&path=${encodeURIComponent(filePath)}`,
      listFilesImpl: async (path?: string) => {
        if (path === filePath) {
          throw new OperatorApiError('files.list', 400, { error: 'ValidationError', message: 'Path is not a directory', issues: [] });
        }
        if (path === parentPath) {
          parentRequestCount += 1;
          return parentRequestCount === 1 ? parentListing : refetchDirectoryRequest.promise;
        }
        if (path === '.saivage/cards') return { path: '.saivage/cards', files: [] };
        return { path: path ?? '', files: [] };
      },
    });
    const refetch = syncMocks.registerResource.mock.calls[0]![0].refetch as () => Promise<void>;
    vi.mocked(getFileContent).mockClear();

    const refetchPromise = refetch();
    await flushPromises();
    await router.push({ name: 'files', query: { root: 'meta', path: '.saivage/cards' } });
    await flushPromises();
    refetchDirectoryRequest.resolve(parentListing);
    await refetchPromise;
    await flushPromises();

    expect(getFileContent).not.toHaveBeenCalled();
    expect(router.currentRoute.value.query).toEqual({ root: 'meta', path: '.saivage/cards' });
    expect(wrapper.find('[data-testid="files-viewer"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('manually refreshes a settled output file through its represented parent and preview', async () => {
    const filePath = '.saivage/work/logs/output.txt';
    const parentPath = '.saivage/work/logs';
    vi.mocked(getFileContent).mockResolvedValue({
      path: filePath,
      size: 32,
      contentType: 'text/plain',
      content: 'complete',
      redacted: false,
      sensitivity: 'normal',
    });
    const { wrapper } = await mountFilesView({
      initialRoute: `/files?root=output&path=${encodeURIComponent(filePath)}`,
      listFilesImpl: async (path?: string) => {
        if (path === filePath) {
          throw new OperatorApiError('files.list', 400, { error: 'ValidationError', message: 'Path is not a directory', issues: [] });
        }
        if (path === parentPath) {
          return {
            path: parentPath,
            files: [{ name: 'output.txt', path: filePath, type: 'file', size: 32, modifiedAt: '2025-06-01T12:00:00Z' }],
          };
        }
        return { path: path ?? '', files: [] };
      },
    });
    vi.mocked(listFiles).mockClear();
    vi.mocked(getFileContent).mockClear();

    await wrapper.find('[data-testid="files-refresh"]').trigger('click');
    await flushPromises();

    expect(vi.mocked(listFiles).mock.calls.map(([path]) => path)).toEqual([parentPath]);
    expect(getFileContent).toHaveBeenCalledOnce();
    expect(getFileContent).toHaveBeenCalledWith(filePath);
    wrapper.unmount();
  });

  it('reports unexpected browse rejection to Vue without compensating root browse or file fetch', async () => {
    const failure = new Error('unexpected browse rejection');
    const errors: unknown[] = [];
    const { wrapper } = await mountFilesView({
      initialRoute: `/files?root=meta&path=${encodeURIComponent('.saivage/logs/app.jsonl')}`,
      configureStore: (store) => { vi.spyOn(store, 'navigateMeta').mockRejectedValueOnce(failure); },
      errorHandler: (error) => { errors.push(error); },
    });

    expect(errors).toEqual([failure]);
    expect(listFiles).not.toHaveBeenCalled();
    expect(getFileContent).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it.each([
    ['.saivage/work', 'output'],
    ['.saivage/work/logs/output.txt', 'output'],
    ['.saivage/logs/app.jsonl', 'meta'],
  ])('selects the canonical root for deep link %s', async (path, expectedRoot) => {
    const { wrapper, router } = await mountFilesView({
      initialRoute: `/files?root=meta&path=${encodeURIComponent(path)}`,
    });

    expect(router.currentRoute.value.query).toEqual({ root: expectedRoot, path });
    wrapper.unmount();
  });

  it('shows viewer state when file preview is blocked', async () => {
    vi.mocked(getFileContent).mockRejectedValue(new OperatorApiError('files.content', 403, { error: 'Protected content — access denied' }));
    const { wrapper } = await mountFilesView();

    await wrapper.findAll('.file-list')[0].findAll('.file-entry')[1].trigger('click');
    await flushPromises();

    expect(wrapper.find('.viewer-state').exists()).toBe(true);
    expect(wrapper.find('.viewer-state').text()).toContain('Preview blocked');
    expect(wrapper.find('.viewer-state').text()).toContain('Protected content — access denied');
  });

  it('shows viewer state when file is missing', async () => {
    vi.mocked(getFileContent).mockRejectedValue(new OperatorApiError('files.content', 404, { error: 'File not found at path', path: 'missing' }));
    const { wrapper } = await mountFilesView();

    await wrapper.findAll('.file-list')[0].findAll('.file-entry')[1].trigger('click');
    await flushPromises();

    expect(wrapper.find('.viewer-state').text()).toContain('File not found');
    expect(wrapper.find('.viewer-state').text()).toContain('File not found at path');
  });

  it('shows unauthorized banner when listing files is rejected with 401', async () => {
    const { wrapper } = await mountFilesView({
      listFilesImpl: async () => {
        throw new OperatorApiError('files.list', 401, { error: 'Unauthorized', statusCode: 401 });
      },
    });

    expect(wrapper.find('[data-testid="files-status-banner"]').text())
      .toContain('API access is unauthorized');
    expect(wrapper.text()).toContain('public docs at /docs/ remain available');
  });

  it('shows JSON content viewer rendering on success', async () => {
    vi.mocked(getFileContent).mockResolvedValue(jsonContent);
    const { wrapper } = await mountFilesView();

    await wrapper.findAll('.file-list')[0].findAll('.file-entry')[1].trigger('click');
    await flushPromises();

    expect(wrapper.find('.code-block').exists()).toBe(true);
  });

  it('shows redaction notice for successful redacted preview', async () => {
    vi.mocked(getFileContent).mockResolvedValue({
      path: '.saivage/saivage.yaml',
      size: 100,
      contentType: 'application/yaml',
      content: 'apiKey: "[REDACTED]"',
      redacted: true,
      sensitivity: 'sensitive-redacted',
    });
    const { wrapper } = await mountFilesView({
      listFilesImpl: async (path?: string) => {
        if (path === '.saivage') {
          return {
            path: '.saivage',
            files: [{ name: 'saivage.yaml', path: '.saivage/saivage.yaml', type: 'file', size: 100, modifiedAt: '2025-06-01T12:00:00Z' }],
          };
        }
        if (path === '.saivage/work') return mockOutputRootFiles;
        return { path: path ?? '', files: [] };
      },
    });

    await wrapper.findAll('.file-list')[0].findAll('.file-entry')[0].trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Sensitive values were redacted by the server.');
  });

  it('clears the active preview when navigating to another folder and renders jsonl/ndjson with JSON icons', async () => {
    vi.mocked(getFileContent).mockResolvedValue(jsonContent);
    const { wrapper } = await mountFilesView({
      listFilesImpl: async (path?: string) => {
        if (path === '.saivage') {
          return {
            path: '.saivage',
            files: [
              { name: 'logs', path: '.saivage/logs', type: 'directory', modifiedAt: '2025-06-01T00:00:00Z' },
              { name: 'plan.json', path: '.saivage/plan.json', type: 'file', size: 2048, modifiedAt: '2025-06-01T12:00:00Z' },
            ],
          };
        }
        if (path === '.saivage/logs') {
          return {
            path: '.saivage/logs',
            files: [
              { name: 'app.jsonl', path: '.saivage/logs/app.jsonl', type: 'file', size: 128, modifiedAt: '2025-06-01T12:00:00Z' },
              { name: 'records.ndjson', path: '.saivage/logs/records.ndjson', type: 'file', size: 128, modifiedAt: '2025-06-01T12:00:00Z' },
            ],
          };
        }
        if (path === '.saivage/work') return mockOutputRootFiles;
        return { path: path ?? '', files: [] };
      },
    });

    await wrapper.findAll('.file-list')[0].findAll('.file-entry')[1].trigger('click');
    await flushPromises();
    expect(wrapper.find('.code-block').exists()).toBe(true);

    await wrapper.findAll('.file-list')[0].findAll('.file-entry')[0].trigger('click');
    await flushPromises();

    expect(wrapper.find('.file-viewer').exists()).toBe(false);
    const icons = wrapper.findAll('.file-list')[0].findAll('.entry-icon').map((icon) => icon.text());
    expect(icons).toEqual(['{}', '{}']);
  });
});
