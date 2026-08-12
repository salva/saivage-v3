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

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [{ path: '/files', name: 'files', component: FilesView }],
  });
}

async function mountFilesView(opts?: {
  initialRoute?: string;
  listFilesImpl?: (path?: string) => Promise<FilesListResponse>;
}) {
  vi.mocked(listFiles).mockImplementation(opts?.listFilesImpl ?? (async (path?: string) => {
    if (path === '.saivage/work') return mockOutputRootFiles;
    if (path === '.saivage') return mockMetaRootFiles;
    if (path === '.saivage/work/logs') return { path: '.saivage/work/logs', files: [] };
    return { path: path ?? '', files: [] };
  }));

  const pinia = createPinia();
  const fileStore = useFileStore(pinia);
  const router = makeRouter();
  await router.push(opts?.initialRoute ?? '/files');
  await router.isReady();

  const wrapper = mount(FilesView, {
    global: { plugins: [pinia, router] },
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

    expect(listFiles).toHaveBeenCalledWith(path);
    expect(listFiles).not.toHaveBeenCalledWith(hiddenPath);
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

    expect(listFiles).toHaveBeenCalledWith(parentPath);
    expect(getFileContent).toHaveBeenCalledWith(filePath);
    expect(listFiles).not.toHaveBeenCalledWith('.saivage/work');
    expect(listFiles).not.toHaveBeenCalledWith(filePath);
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
