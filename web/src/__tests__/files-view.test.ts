import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import FilesView from '../views/FilesView.vue';
import type { FileContent, FilesListResponse } from '../api/types';

vi.mock('../api/client', () => {
  const ApiError = class extends Error {
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
  };
  return {
    listFiles: vi.fn(),
    getFileContent: vi.fn(),
    ApiError,
  };
});

vi.mock('../stores/ws', () => ({
  useWsStore: () => ({
    onReconnect: vi.fn(() => () => {}),
  }),
}));

import { listFiles, getFileContent, ApiError } from '../api/client';

const mockMetaRootFiles: FilesListResponse = {
  path: '.saivage',
  files: [
    { name: 'cards', path: '.saivage/cards', type: 'directory', modifiedAt: '2025-06-01T00:00:00Z' },
    { name: 'plan.json', path: '.saivage/plan.json', type: 'file', size: 2048, modifiedAt: '2025-06-01T12:00:00Z' },
  ],
};

const mockOutputRootFiles: FilesListResponse = {
  path: '.saivage-work',
  files: [
    { name: 'logs', path: '.saivage-work/logs', type: 'directory', modifiedAt: '2025-06-01T00:00:00Z' },
    { name: 'output.txt', path: '.saivage-work/output.txt', type: 'file', size: 8192, modifiedAt: '2025-06-01T12:00:00Z' },
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
    if (path === '.saivage-work') return mockOutputRootFiles;
    if (path === '.saivage') return mockMetaRootFiles;
    if (path === '.saivage-work/logs') return { path: '.saivage-work/logs', files: [] };
    return { path: path ?? '', files: [] };
  }));

  const pinia = createPinia();
  const router = makeRouter();
  await router.push(opts?.initialRoute ?? '/files');
  await router.isReady();

  const wrapper = mount(FilesView, {
    global: { plugins: [pinia, router] },
  });
  await flushPromises();
  return { wrapper, router };
}

describe('FilesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders both Metadata and Output panels', async () => {
    const { wrapper } = await mountFilesView();
    expect(wrapper.find('[data-testid="files-canonical-panel"]').exists()).toBe(true);
  });

  it('shows viewer state when file preview is blocked', async () => {
    vi.mocked(getFileContent).mockRejectedValue(new ApiError(403, 'Protected content — access denied', {}));
    const { wrapper } = await mountFilesView();

    await wrapper.findAll('.file-list')[0].findAll('.file-entry')[1].trigger('click');
    await flushPromises();

    expect(wrapper.find('.viewer-state').exists()).toBe(true);
    expect(wrapper.find('.viewer-state').text()).toContain('Preview blocked');
    expect(wrapper.find('.viewer-state').text()).toContain('Protected content — access denied');
  });

  it('shows viewer state when file is missing', async () => {
    vi.mocked(getFileContent).mockRejectedValue(new ApiError(404, 'File not found at path', {}));
    const { wrapper } = await mountFilesView();

    await wrapper.findAll('.file-list')[0].findAll('.file-entry')[1].trigger('click');
    await flushPromises();

    expect(wrapper.find('.viewer-state').text()).toContain('File not found');
    expect(wrapper.find('.viewer-state').text()).toContain('File not found at path');
  });

  it('shows unauthorized banner when listing files is rejected with 401', async () => {
    const { wrapper } = await mountFilesView({
      listFilesImpl: async () => {
        throw new ApiError(401, 'Unauthorized — valid API token required', {});
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
      path: '.saivage/saivage.json',
      size: 100,
      contentType: 'application/json',
      content: '{"apiKey":"[REDACTED]"}',
      redacted: true,
      sensitivity: 'sensitive-redacted',
    });
    const { wrapper } = await mountFilesView({
      listFilesImpl: async (path?: string) => {
        if (path === '.saivage') {
          return {
            path: '.saivage',
            files: [{ name: 'saivage.json', path: '.saivage/saivage.json', type: 'file', size: 100, modifiedAt: '2025-06-01T12:00:00Z' }],
          };
        }
        if (path === '.saivage-work') return mockOutputRootFiles;
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
              { name: 'runtime', path: '.saivage/runtime', type: 'directory', modifiedAt: '2025-06-01T00:00:00Z' },
              { name: 'plan.json', path: '.saivage/plan.json', type: 'file', size: 2048, modifiedAt: '2025-06-01T12:00:00Z' },
            ],
          };
        }
        if (path === '.saivage/runtime') {
          return {
            path: '.saivage/runtime',
            files: [
              { name: 'events.jsonl', path: '.saivage/runtime/events.jsonl', type: 'file', size: 128, modifiedAt: '2025-06-01T12:00:00Z' },
              { name: 'records.ndjson', path: '.saivage/runtime/records.ndjson', type: 'file', size: 128, modifiedAt: '2025-06-01T12:00:00Z' },
            ],
          };
        }
        if (path === '.saivage-work') return mockOutputRootFiles;
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
