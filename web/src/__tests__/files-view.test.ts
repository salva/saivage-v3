/**
 * Component-level regression tests for FilesView.
 *
 * Tests cover:
 *  1. Operator interaction: breadcrumb navigation clicks (metadata & output)
 *  2. Operator interaction: file entry click opens content viewer
 *  3. Operator interaction: directory entry click navigates into directory
 *  4. Operator interaction: quarantine footer "Browse" button navigates output panel
 *  5. Operator interaction: viewer close button clears viewed file
 *  6. Operator interaction: refresh buttons trigger refetch
 *  7. Visible presentation: loading states for both panels
 *  8. Visible presentation: empty states when no files exist
 *  9. Visible presentation: JSON content viewer rendering (json-view class)
 * 10. Visible presentation: Markdown content viewer rendering (md-view class)
 * 11. Visible presentation: plain text viewer rendering (plain-view class)
 * 12. Visible presentation: directory entries have is-dir class, file icons shown
 * 13. Route query path: ?path=.saivage-work/... navigates output panel on mount
 * 14. Route query path: watcher re-fires on query change
 * 15. Viewer loading state: viewer shell appears immediately with loading indicator
 *
 * The API client is fully mocked — no server needed.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import FilesView from '../views/FilesView.vue';
import type { FileEntry, FileContent, FilesListResponse } from '../api/types';

// ── Mock the API client ───────────────────────────────────────
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

import { listFiles, getFileContent } from '../api/client';

// ── Fixtures ──────────────────────────────────────────────────

const mockMetaRootFiles: FilesListResponse = {
  path: '.saivage',
  files: [
    { name: 'cards', path: '.saivage/cards', type: 'directory', modifiedAt: '2025-06-01T00:00:00Z' },
    { name: 'plan.json', path: '.saivage/plan.json', type: 'file', size: 2048, modifiedAt: '2025-06-01T12:00:00Z' },
    { name: 'config.yaml', path: '.saivage/config.yaml', type: 'file', size: 512, modifiedAt: '2025-06-01T06:00:00Z' },
  ],
};

const mockMetaCardsFiles: FilesListResponse = {
  path: '.saivage/cards',
  files: [
    { name: 'card-001.json', path: '.saivage/cards/card-001.json', type: 'file', size: 4096, modifiedAt: '2025-06-02T00:00:00Z' },
    { name: 'sub', path: '.saivage/cards/sub', type: 'directory', modifiedAt: '2025-06-01T08:00:00Z' },
  ],
};

const mockOutputRootFiles: FilesListResponse = {
  path: '.saivage-work',
  files: [
    { name: 'logs', path: '.saivage-work/logs', type: 'directory', modifiedAt: '2025-06-01T00:00:00Z' },
    { name: 'output.txt', path: '.saivage-work/output.txt', type: 'file', size: 8192, modifiedAt: '2025-06-01T12:00:00Z' },
  ],
};

const mockOutputLogsFiles: FilesListResponse = {
  path: '.saivage-work/logs',
  files: [
    { name: 'agent.log', path: '.saivage-work/logs/agent.log', type: 'file', size: 4096, modifiedAt: '2025-06-01T12:00:00Z' },
  ],
};

const mockQuarantineFiles: FilesListResponse = {
  path: '.saivage-work/quarantine',
  files: [
    { name: 'qr-abc123', path: '.saivage-work/quarantine/qr-abc123', type: 'directory', modifiedAt: '2025-06-01T00:00:00Z' },
  ],
};

const jsonContent: FileContent = {
  path: '.saivage/plan.json',
  size: 2048,
  contentType: 'application/json',
  content: '{"version":3,"project":"saivage-v3"}',
};

const markdownContent: FileContent = {
  path: '.saivage-work/report.md',
  size: 1024,
  contentType: 'text/markdown',
  content: '# Report\n## Summary\n**Important** note here.',
};

const plainTextContent: FileContent = {
  path: '.saivage-work/output.txt',
  size: 8192,
  contentType: 'text/plain',
  content: 'Line 1\nLine 2\nLine 3',
};

// ── Router ────────────────────────────────────────────────────
function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/files', name: 'files', component: FilesView },
    ],
  });
}

// ── Mount helper ──────────────────────────────────────────────
async function mountFilesView(opts?: {
  metaFiles?: FilesListResponse;
  outputFiles?: FilesListResponse;
  /** Override specific path responses */
  pathOverrides?: Record<string, FilesListResponse>;
  /** Route query to apply. Default: no query. */
  initialRoute?: string;
}) {
  const pinia = createPinia();

  vi.mocked(listFiles).mockImplementation(async (path?: string) => {
    const p = path ?? '';
    // Check exact path overrides first
    if (opts?.pathOverrides && p in opts.pathOverrides) {
      return opts.pathOverrides[p];
    }
    // Specific paths
    if (p === '.saivage-work/quarantine') return mockQuarantineFiles;
    if (p === '.saivage-work/logs') return mockOutputLogsFiles;
    if (p === '.saivage/cards') return mockMetaCardsFiles;
    // Root paths — check explicit prefixes to avoid .saivage matching .saivage-work
    if (p === '.saivage') return opts?.metaFiles ?? mockMetaRootFiles;
    if (p === '.saivage-work') return opts?.outputFiles ?? mockOutputRootFiles;
    // Path prefixes — check .saivage-work BEFORE .saivage to avoid false matches
    if (p.startsWith('.saivage-work/')) return opts?.outputFiles ?? mockOutputRootFiles;
    if (p.startsWith('.saivage/')) return opts?.metaFiles ?? mockMetaRootFiles;
    // Fallback
    return { path: p, files: [] };
  });

  const router = makeRouter();
  const route = opts?.initialRoute ?? '/files';
  await router.push(route);
  await router.isReady();

  const wrapper = mount(FilesView, {
    global: { plugins: [pinia, router] },
  });
  await flushPromises();
  return { wrapper, router };
}

// ── Tests ─────────────────────────────────────────────────────

describe('FilesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Visible Presentation: Initial State ─────────────────────

  describe('visible presentation — initial render', () => {
    it('renders both Metadata and Output panels', async () => {
      const { wrapper } = await mountFilesView();

      const panels = wrapper.findAll('.file-panel');
      expect(panels).toHaveLength(2);

      const titles = wrapper.findAll('.panel-title');
      expect(titles[0].text()).toBe('Metadata');
      expect(titles[1].text()).toBe('Output');
    });

    it('shows panel root labels', async () => {
      const { wrapper } = await mountFilesView();

      const roots = wrapper.findAll('.panel-root');
      expect(roots[0].text()).toBe('.saivage/');
      expect(roots[1].text()).toBe('.saivage-work/');
    });

    it('renders breadcrumbs for both panels at root level', async () => {
      const { wrapper } = await mountFilesView();

      const breadcrumbContainers = wrapper.findAll('.file-breadcrumbs');
      expect(breadcrumbContainers).toHaveLength(2);

      // Metadata breadcrumbs: just ['.saivage']
      const metaCrumbs = breadcrumbContainers[0].findAll('.crumb');
      expect(metaCrumbs).toHaveLength(1);
      expect(metaCrumbs[0].text()).toContain('.saivage');

      // Output breadcrumbs: just ['.saivage-work']
      const outputCrumbs = breadcrumbContainers[1].findAll('.crumb');
      expect(outputCrumbs).toHaveLength(1);
      expect(outputCrumbs[0].text()).toContain('.saivage-work');
    });

    it('renders file entries with correct icon and name', async () => {
      const { wrapper } = await mountFilesView();

      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');
      expect(metaEntries).toHaveLength(3);

      // First entry is a directory
      expect(metaEntries[0].classes()).toContain('is-dir');
      expect(metaEntries[0].find('.entry-icon').text()).toBe('📁');
      expect(metaEntries[0].find('.entry-name').text()).toBe('cards');

      // Second entry is a .json file
      expect(metaEntries[1].find('.entry-icon').text()).toBe('{}');
      expect(metaEntries[1].find('.entry-name').text()).toBe('plan.json');
    });

    it('renders entry size for files', async () => {
      const { wrapper } = await mountFilesView();

      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');

      // plan.json: 2048 bytes = 2.0KB
      expect(metaEntries[1].find('.entry-size').text()).toBe('2.0KB');
    });

    it('renders entry modified date', async () => {
      const { wrapper } = await mountFilesView();

      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');

      // Should show a formatted date (not empty)
      expect(metaEntries[0].find('.entry-modified').text()).toBeTruthy();
    });
  });

  // ── Visible Presentation: Loading States ────────────────────

  describe('visible presentation — loading states', () => {
    it('shows "Loading..." in metadata panel while metaLoading is true', async () => {
      const pinia = createPinia();

      // Defer listFiles so loading stays true
      let resolveList: (v: any) => void;
      const pending = new Promise<any>(r => { resolveList = r; });
      vi.mocked(listFiles).mockReturnValue(pending);

      const router = makeRouter();
      await router.push('/files');
      await router.isReady();

      const wrapper = mount(FilesView, {
        global: { plugins: [pinia, router] },
      });
      await flushPromises();

      const loadingEls = wrapper.findAll('.panel-loading');
      expect(loadingEls).toHaveLength(2);
      expect(loadingEls[0].text()).toBe('Loading...');

      resolveList!(mockMetaRootFiles);
      resolveList!(mockOutputRootFiles);
      await flushPromises();

      // Loading should disappear
      expect(wrapper.findAll('.panel-loading')).toHaveLength(0);
    });
  });

  // ── Visible Presentation: Empty States ──────────────────────

  describe('visible presentation — empty states', () => {
    it('shows "No files" when metaFiles is empty and not loading', async () => {
      const pinia = createPinia();
      vi.mocked(listFiles).mockResolvedValue({ path: '.saivage', files: [] });

      const router = makeRouter();
      await router.push('/files');
      await router.isReady();

      const wrapper = mount(FilesView, {
        global: { plugins: [pinia, router] },
      });
      await flushPromises();

      const emptyEls = wrapper.findAll('.panel-empty');
      expect(emptyEls).toHaveLength(2);
      expect(emptyEls[0].text()).toBe('No files');
    });
  });

  // ── Operator Interaction: Breadcrumb Navigation ─────────────

  describe('operator interaction — breadcrumb navigation', () => {
    it('clicking a breadcrumb link in metadata navigates to that path', async () => {
      const { wrapper } = await mountFilesView();

      // First, navigate into a directory by clicking on a directory entry
      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');
      // Click the "cards" directory
      await metaEntries[0].trigger('click');
      await flushPromises();

      // Now breadcrumbs should show '.saivage / cards'
      const breadcrumbContainers = wrapper.findAll('.file-breadcrumbs');
      const metaCrumbs = breadcrumbContainers[0].findAll('.crumb');
      expect(metaCrumbs).toHaveLength(2);
      expect(metaCrumbs[1].text()).toContain('cards');

      // Click the root breadcrumb to navigate back
      const rootCrumbLink = metaCrumbs[0].find('.crumb-link');
      await rootCrumbLink.trigger('click');
      await flushPromises();

      // Should be back to root — verify breadcrumb is root-level again
      const updatedCrumbs = wrapper.findAll('.file-breadcrumbs')[0].findAll('.crumb');
      expect(updatedCrumbs).toHaveLength(1);
    });

    it('clicking a breadcrumb link in output panel navigates to parent', async () => {
      const { wrapper } = await mountFilesView();

      const fileLists = wrapper.findAll('.file-list');
      const outputEntries = fileLists[1].findAll('.file-entry');
      // Click the "logs" directory — output should navigate there
      await outputEntries[0].trigger('click');
      await flushPromises();

      // Breadcrumbs should show '.saivage-work / logs'
      const breadcrumbContainers = wrapper.findAll('.file-breadcrumbs');
      const outputCrumbs = breadcrumbContainers[1].findAll('.crumb');
      expect(outputCrumbs).toHaveLength(2);
      expect(outputCrumbs[1].text()).toContain('logs');

      // Click the root breadcrumb to navigate back
      const rootCrumbLink = outputCrumbs[0].find('.crumb-link');
      await rootCrumbLink.trigger('click');
      await flushPromises();

      // Should be back to root
      const updatedCrumbs = wrapper.findAll('.file-breadcrumbs')[1].findAll('.crumb');
      expect(updatedCrumbs).toHaveLength(1);
    });
  });

  // ── Operator Interaction: File Selection → Viewer ───────────

  describe('operator interaction — file selection opens viewer', () => {
    it('clicking a file entry opens content viewer', async () => {
      vi.mocked(getFileContent).mockResolvedValue(jsonContent);
      const { wrapper } = await mountFilesView();

      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');

      // Click "plan.json" (second entry, index 1)
      await metaEntries[1].trigger('click');
      await flushPromises();

      // Viewer should appear
      expect(wrapper.find('.file-viewer').exists()).toBe(true);
      expect(wrapper.find('.viewer-path').text()).toBe('.saivage/plan.json');
      expect(getFileContent).toHaveBeenCalledWith('.saivage/plan.json');
    });

    it('clicking a directory entry navigates into directory (no viewer)', async () => {
      const { wrapper } = await mountFilesView();

      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');

      // Click directory "cards" (first entry)
      await metaEntries[0].trigger('click');
      await flushPromises();

      // Viewer should NOT appear for directory clicks
      expect(wrapper.find('.file-viewer').exists()).toBe(false);
      expect(getFileContent).not.toHaveBeenCalled();
    });
  });

  // ── Operator Interaction: Viewer Close ──────────────────────

  describe('operator interaction — viewer close', () => {
    it('clicking X button closes the viewer', async () => {
      vi.mocked(getFileContent).mockResolvedValue(jsonContent);
      const { wrapper } = await mountFilesView();

      // Open viewer
      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');
      await metaEntries[1].trigger('click');
      await flushPromises();

      expect(wrapper.find('.file-viewer').exists()).toBe(true);

      // Click close button
      await wrapper.find('.viewer-close-btn').trigger('click');
      await flushPromises();

      expect(wrapper.find('.file-viewer').exists()).toBe(false);
    });
  });

  // ── Visible Presentation: JSON Viewer ───────────────────────

  describe('visible presentation — JSON viewer', () => {
    it('renders JSON content with .json-view class', async () => {
      vi.mocked(getFileContent).mockResolvedValue(jsonContent);
      const { wrapper } = await mountFilesView();

      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');
      await metaEntries[1].trigger('click'); // plan.json
      await flushPromises();

      // JSON should render in a <pre class="json-view">
      const jsonPre = wrapper.find('.json-view');
      expect(jsonPre.exists()).toBe(true);
      // Content should be pretty-printed
      expect(jsonPre.text()).toContain('"version"');
      expect(jsonPre.text()).toContain('"saivage-v3"');
    });

    it('does NOT render JSON as markdown or plain text', async () => {
      vi.mocked(getFileContent).mockResolvedValue(jsonContent);
      const { wrapper } = await mountFilesView();

      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');
      await metaEntries[1].trigger('click');
      await flushPromises();

      expect(wrapper.find('.md-view').exists()).toBe(false);
      expect(wrapper.find('.plain-view').exists()).toBe(false);
    });
  });

  // ── Visible Presentation: Markdown Viewer ───────────────────

  describe('visible presentation — Markdown viewer', () => {
    it('renders Markdown content with .md-view class', async () => {
      vi.mocked(getFileContent).mockResolvedValue(markdownContent);

      // Need an .md file in the file list
      const mdMetaFiles: FilesListResponse = {
        path: '.saivage',
        files: [
          { name: 'report.md', path: '.saivage/report.md', type: 'file', size: 1024, modifiedAt: '2025-06-01T00:00:00Z' },
        ],
      };
      const { wrapper } = await mountFilesView({ metaFiles: mdMetaFiles });

      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');
      await metaEntries[0].trigger('click');
      await flushPromises();

      const mdView = wrapper.find('.md-view');
      expect(mdView.exists()).toBe(true);
      // Content should contain rendered HTML (strong tags for **Important**)
      expect(mdView.html()).toContain('<strong>');
    });

    it('renders inline code in Markdown', async () => {
      vi.mocked(getFileContent).mockResolvedValue({
        path: '.saivage/notes.md',
        size: 200,
        contentType: 'text/markdown',
        content: 'Run `npm test` to verify.',
      });

      const mdFiles: FilesListResponse = {
        path: '.saivage',
        files: [
          { name: 'notes.md', path: '.saivage/notes.md', type: 'file', size: 200, modifiedAt: '2025-06-01T00:00:00Z' },
        ],
      };
      const { wrapper } = await mountFilesView({ metaFiles: mdFiles });

      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');
      await metaEntries[0].trigger('click');
      await flushPromises();

      const mdView = wrapper.find('.md-view');
      expect(mdView.html()).toContain('class="inline-code"');
      expect(mdView.html()).toContain('npm test');
    });
  });

  // ── Visible Presentation: Plain Text Viewer ─────────────────

  describe('visible presentation — plain text viewer', () => {
    it('renders plain text content with .plain-view class', async () => {
      vi.mocked(getFileContent).mockResolvedValue(plainTextContent);
      const { wrapper } = await mountFilesView();

      // Click output.txt in output panel
      const fileLists = wrapper.findAll('.file-list');
      const outputEntries = fileLists[1].findAll('.file-entry');
      // output.txt is the second entry (index 1)
      await outputEntries[1].trigger('click');
      await flushPromises();

      const plainView = wrapper.find('.plain-view');
      expect(plainView.exists()).toBe(true);
      expect(plainView.text()).toBe('Line 1\nLine 2\nLine 3');
    });

    it('plain text does not use JSON or Markdown classes', async () => {
      vi.mocked(getFileContent).mockResolvedValue(plainTextContent);
      const { wrapper } = await mountFilesView();

      const fileLists = wrapper.findAll('.file-list');
      const outputEntries = fileLists[1].findAll('.file-entry');
      await outputEntries[1].trigger('click');
      await flushPromises();

      expect(wrapper.find('.json-view').exists()).toBe(false);
      expect(wrapper.find('.md-view').exists()).toBe(false);
    });
  });

  // ── Operator Interaction: Quarantine Footer ─────────────────

  describe('operator interaction — quarantine footer', () => {
    it('renders quarantine footer with label and button', async () => {
      const { wrapper } = await mountFilesView();

      const footer = wrapper.find('.quarantine-footer');
      expect(footer.exists()).toBe(true);
      expect(footer.find('.quarantine-footer-label').text()).toBe('Quarantine');
      expect(footer.find('.quarantine-footer-btn').text()).toContain('Browse .saivage-work/quarantine/');
    });

    it('clicking quarantine Browse button navigates output to .saivage-work/quarantine', async () => {
      const { wrapper } = await mountFilesView();

      // Clear listFiles calls from mount
      vi.mocked(listFiles).mockClear();
      // Mock the quarantine path explicitly
      vi.mocked(listFiles).mockImplementation(async (path?: string) => {
        const p = path ?? '';
        if (p === '.saivage-work/quarantine') return mockQuarantineFiles;
        return { path: p, files: [] };
      });

      const btn = wrapper.find('.quarantine-footer-btn');
      await btn.trigger('click');
      await flushPromises();

      expect(listFiles).toHaveBeenCalledWith('.saivage-work/quarantine');
    });
  });

  // ── Operator Interaction: Refresh Buttons ───────────────────

  describe('operator interaction — refresh buttons', () => {
    it('metadata refresh button triggers fetchMetaFiles', async () => {
      const { wrapper } = await mountFilesView();

      // Clear mocks from mount
      vi.mocked(listFiles).mockClear();

      const refreshBtns = wrapper.findAll('.panel-refresh-btn');
      await refreshBtns[0].trigger('click');
      await flushPromises();

      // Expect call for metadata panel refresh (path === '.saivage')
      const metaCalls = vi.mocked(listFiles).mock.calls.filter(
        c => c[0] === '.saivage',
      );
      expect(metaCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('output refresh button triggers fetchOutputFiles', async () => {
      const { wrapper } = await mountFilesView();

      vi.mocked(listFiles).mockClear();

      const refreshBtns = wrapper.findAll('.panel-refresh-btn');
      await refreshBtns[1].trigger('click');
      await flushPromises();

      // Expect call for output panel refresh (path === '.saivage-work')
      const outputCalls = vi.mocked(listFiles).mock.calls.filter(
        c => c[0] === '.saivage-work',
      );
      expect(outputCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('refresh buttons have disabled class while loading', async () => {
      const pinia = createPinia();

      let resolveList: (v: any) => void;
      const pending = new Promise<any>(r => { resolveList = r; });
      vi.mocked(listFiles).mockReturnValue(pending);

      const router = makeRouter();
      await router.push('/files');
      await router.isReady();

      const wrapper = mount(FilesView, {
        global: { plugins: [pinia, router] },
      });
      await flushPromises();

      const refreshBtns = wrapper.findAll('.panel-refresh-btn');
      // Both buttons should be disabled while loading
      for (const btn of refreshBtns) {
        expect((btn.element as HTMLButtonElement).disabled).toBe(true);
      }

      resolveList!(mockMetaRootFiles);
      resolveList!(mockOutputRootFiles);
      await flushPromises();
    });
  });

  // ── Route Query Path: ?path= ────────────────────────────────

  describe('route query path handling', () => {
    it('navigates output panel to .saivage-work/quarantine when ?path= query is set', async () => {
      vi.mocked(listFiles).mockImplementation(async (path?: string) => {
        const p = path ?? '';
        if (p === '.saivage-work/quarantine') return mockQuarantineFiles;
        if (p === '.saivage') return mockMetaRootFiles;
        if (p === '.saivage-work') return mockOutputRootFiles;
        return { path: p, files: [] };
      });

      const { wrapper } = await mountFilesView({
        initialRoute: '/files?path=.saivage-work/quarantine',
      });

      // Should have navigated output panel to quarantine
      expect(listFiles).toHaveBeenCalledWith('.saivage-work/quarantine');
    });

    it('does NOT navigate output panel for non-.saivage-work/ paths', async () => {
      await mountFilesView({
        initialRoute: '/files?path=.saivage/plan.json',
      });

      // The component only navigates if path starts with '.saivage-work/'
      const quarantineCalls = vi.mocked(listFiles).mock.calls.filter(
        c => c[0]?.startsWith('.saivage-work/quarantine'),
      );
      expect(quarantineCalls).toHaveLength(0);
    });

    it('does nothing when no ?path= query is present', async () => {
      // The normal mount without query should work fine — no errors
      await mountFilesView({ initialRoute: '/files' });
      // Should not throw; listFiles called for both roots
      expect(listFiles).toHaveBeenCalledWith('.saivage');
    });
  });

  // ── Viewer Loading State ────────────────────────────────────

  describe('visible presentation — content viewer loading', () => {
    it('shows "Loading..." in viewer while content is being fetched', async () => {
      let resolveContent: (v: any) => void;
      const pending = new Promise<any>(r => { resolveContent = r; });
      vi.mocked(getFileContent).mockReturnValue(pending);

      const { wrapper } = await mountFilesView();

      // Click a file to open viewer
      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');
      await metaEntries[1].trigger('click'); // plan.json
      await flushPromises();

      // Viewer shell should appear immediately with loading state
      // (viewedFilePath is now set before the await in fetchFileContent)
      expect(wrapper.find('.file-viewer').exists()).toBe(true);
      expect(wrapper.find('.viewer-loading').exists()).toBe(true);
      expect(wrapper.find('.viewer-loading').text()).toBe('Loading...');

      // Resolve and loading disappears, content appears
      resolveContent!(jsonContent);
      await flushPromises();

      expect(wrapper.find('.viewer-loading').exists()).toBe(false);
      expect(wrapper.find('.json-view').exists()).toBe(true);
    });
  });

  // ── File Icon Mapping ───────────────────────────────────────

  describe('visible presentation — file icons', () => {
    it('maps known extensions to correct icon text', async () => {
      const mixedFiles: FilesListResponse = {
        path: '.saivage',
        files: [
          { name: 'data.json', path: '.saivage/data.json', type: 'file', size: 100, modifiedAt: '2025-06-01T00:00:00Z' },
          { name: 'readme.md', path: '.saivage/readme.md', type: 'file', size: 100, modifiedAt: '2025-06-01T00:00:00Z' },
          { name: 'script.ts', path: '.saivage/script.ts', type: 'file', size: 100, modifiedAt: '2025-06-01T00:00:00Z' },
          { name: 'index.js', path: '.saivage/index.js', type: 'file', size: 100, modifiedAt: '2025-06-01T00:00:00Z' },
          { name: 'notes.txt', path: '.saivage/notes.txt', type: 'file', size: 100, modifiedAt: '2025-06-01T00:00:00Z' },
          { name: 'unknown.xyz', path: '.saivage/unknown.xyz', type: 'file', size: 100, modifiedAt: '2025-06-01T00:00:00Z' },
        ],
      };

      const { wrapper } = await mountFilesView({ metaFiles: mixedFiles });

      const fileLists = wrapper.findAll('.file-list');
      const icons = fileLists[0].findAll('.entry-icon');

      expect(icons[0].text()).toBe('{}');  // .json
      expect(icons[1].text()).toBe('MD');  // .md
      expect(icons[2].text()).toBe('TS');  // .ts
      expect(icons[3].text()).toBe('JS');  // .js
      expect(icons[4].text()).toBe('TX');  // .txt
      expect(icons[5].text()).toBe('--');  // .xyz (unknown)
    });

    it('shows folder icon for directory entries', async () => {
      const { wrapper } = await mountFilesView();

      const fileLists = wrapper.findAll('.file-list');
      const metaEntries = fileLists[0].findAll('.file-entry');
      // First entry is "cards" directory
      expect(metaEntries[0].find('.entry-icon').text()).toBe('📁');
    });
  });

  // ── Size Formatting ─────────────────────────────────────────

  describe('visible presentation — size formatting', () => {
    it('formats bytes correctly (B, KB, MB)', async () => {
      const sizedFiles: FilesListResponse = {
        path: '.saivage',
        files: [
          { name: 'tiny.txt', path: '.saivage/tiny.txt', type: 'file', size: 512, modifiedAt: '2025-06-01T00:00:00Z' },
          { name: 'big.json', path: '.saivage/big.json', type: 'file', size: 1536000, modifiedAt: '2025-06-01T00:00:00Z' },
        ],
      };

      const { wrapper } = await mountFilesView({ metaFiles: sizedFiles });

      const fileLists = wrapper.findAll('.file-list');
      const sizes = fileLists[0].findAll('.entry-size');

      expect(sizes[0].text()).toBe('512B');
      expect(sizes[1].text()).toBe('1.5MB');
    });
  });
});
