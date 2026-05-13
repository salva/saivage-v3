/**
 * Bounded component-level regression tests for the DebugView
 * MCP tab behaviour.
 *
 * These tests mount the DebugView component using Vue Test Utils +
 * jsdom and verify that the MCP tab renders expected elements
 * when the MCP store contains server/tool/invocation data.
 *
 * The API client is fully mocked — no server needed.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import DebugView from '../views/DebugView.vue';
import { useMcpStore } from '../stores/mcp';

// ── Mock the API client ───────────────────────────────────────
vi.mock('../api/client', () => {
  const ApiError = class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  };
  return {
    getDoctor: vi.fn(),
    getDebugSupervision: vi.fn(),
    getDebugState: vi.fn(),
    getDebugErrors: vi.fn(),
    getDebugTimeline: vi.fn(),
    listProcesses: vi.fn(),
    getMcpTools: vi.fn(),
    ApiError,
  };
});

// Mock the WebSocket store — DebugView calls useWsStore
vi.mock('../stores/ws', () => ({
  useWsStore: () => ({
    onType: vi.fn(() => vi.fn()),
    connectionState: { value: 'offline' },
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    fetchMcpData: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: () => false,
    isConnecting: () => false,
  }),
}));

// Mock vue-router's useRouter
const mockPush = vi.fn();
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>();
  return {
    ...actual,
    useRouter: () => ({
      push: mockPush,
      currentRoute: { value: { query: {} } },
    }),
  };
});

import { getMcpTools } from '../api/client';
import type { McpToolsResponse } from '../api/types';

// ── Fixtures ──────────────────────────────────────────────────

const mockRichResponse: McpToolsResponse = {
  tools: [
    { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
    { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } },
    { name: 'web_search', description: 'Search the web', inputSchema: { type: 'object' } },
  ],
  servers: ['filesystem', 'web'],
  invocationStats: {
    'filesystem:read_file': { total: 42, success: 40, error: 2, lastInvokedAt: '2025-07-01T10:00:00Z' },
    'filesystem:write_file': { total: 15, success: 15, error: 0, lastInvokedAt: '2025-07-01T09:30:00Z' },
    'web:web_search': { total: 8, success: 7, error: 1, lastInvokedAt: '2025-07-01T08:00:00Z' },
  },
  serverDetails: [
    {
      name: 'filesystem',
      transport: 'stdio',
      status: 'running',
      toolCount: 2,
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: { type: 'object' as const },
          stats: { total: 42, success: 40, error: 2, lastInvokedAt: '2025-07-01T10:00:00Z' },
        },
        {
          name: 'write_file',
          description: 'Write a file',
          inputSchema: { type: 'object' as const },
          stats: { total: 15, success: 15, error: 0, lastInvokedAt: '2025-07-01T09:30:00Z' },
        },
      ],
    },
    {
      name: 'web',
      transport: 'sse',
      status: 'running',
      toolCount: 1,
      tools: [
        {
          name: 'web_search',
          description: 'Search the web',
          inputSchema: { type: 'object' as const },
          stats: { total: 8, success: 7, error: 1, lastInvokedAt: '2025-07-01T08:00:00Z' },
        },
      ],
    },
  ],
};

const mockEmptyResponse: McpToolsResponse = {
  tools: [],
  servers: [],
  invocationStats: {},
  serverDetails: [],
};

const mockServerRunningNoTools: McpToolsResponse = {
  tools: [],
  servers: ['empty-server'],
  invocationStats: {},
  serverDetails: [
    {
      name: 'empty-server',
      transport: 'sse',
      status: 'running',
      toolCount: 0,
      tools: [],
    },
  ],
};

const mockServerErrorState: McpToolsResponse = {
  tools: [
    { name: 'fail_tool', description: 'Always fails', inputSchema: { type: 'object' } },
  ],
  servers: ['broken'],
  invocationStats: {
    'broken:fail_tool': { total: 5, success: 0, error: 5, lastInvokedAt: '2025-07-01T07:00:00Z' },
  },
  serverDetails: [
    {
      name: 'broken',
      transport: 'stdio',
      status: 'error',
      toolCount: 1,
      tools: [
        {
          name: 'fail_tool',
          description: 'Always fails',
          inputSchema: { type: 'object' as const },
          stats: { total: 5, success: 0, error: 5, lastInvokedAt: '2025-07-01T07:00:00Z' },
        },
      ],
    },
  ],
};

// ── Router factory ────────────────────────────────────────────

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/files', name: 'files', component: { template: '<div>Files</div>' } },
    ],
  });
}

// ── Mount helpers ─────────────────────────────────────────────

async function mountDebugView() {
  setActivePinia(createPinia());

  const router = makeRouter();
  const wrapper = mount(DebugView, {
    global: {
      plugins: [createPinia(), router],
    },
  });

  // Wait for any onMounted side-effects to settle
  await flushPromises();
  return wrapper;
}

/**
 * Mount DebugView and pre-populate the MCP store before clicking the tab.
 * This lets us verify that the MCP tab renders data without relying on
 * the onMounted fetchAll or tab-click fetch.
 */
async function mountDebugViewWithMcpData(response: McpToolsResponse) {
  setActivePinia(createPinia());

  // Pre-populate the MCP store
  const mcpStore = useMcpStore();
  vi.mocked(getMcpTools).mockResolvedValue(response);
  await mcpStore.fetchMcpData();

  const router = makeRouter();
  const wrapper = mount(DebugView, {
    global: {
      plugins: [createPinia(), router],
    },
  });

  await flushPromises();
  return wrapper;
}

function clickMcpTab(wrapper: ReturnType<typeof mount>) {
  const tabs = wrapper.findAll('.debug-tab');
  const mcpTab = tabs.find((t) => t.text() === 'MCP');
  if (mcpTab) {
    mcpTab.trigger('click');
  }
}

// ── Tests ─────────────────────────────────────────────────────

describe('DebugView — MCP tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Tab-switch / operator interaction ───────────────────────

  it('renders the MCP tab button', async () => {
    const wrapper = await mountDebugView();
    const tabs = wrapper.findAll('.debug-tab');
    const labels = tabs.map((t) => t.text());
    expect(labels).toContain('MCP');
  });

  it('activates MCP tab on click and shows MCP content area', async () => {
    const wrapper = await mountDebugViewWithMcpData(mockRichResponse);
    clickMcpTab(wrapper);
    await flushPromises();

    // The MCP tab content should be visible (v-if based on localActiveTab)
    const tabContents = wrapper.findAll('.debug-tab-content');
    // At least one content area is rendered
    expect(tabContents.length).toBeGreaterThanOrEqual(1);

    // The Summary section should be present when MCP data is loaded
    const sectionTitles = wrapper.findAll('.debug-section-title');
    const titles = sectionTitles.map((t) => t.text());
    expect(titles).toContain('Summary');
  });

  it('renders MCP-tab loading state when store is loading', async () => {
    // Mount without pre-populating; the store's loading ref will be false
    // after the initial mount, but we can verify the loading state
    // by mounting fresh with the store still in default state.
    setActivePinia(createPinia());

    // Force the mcpStore into loading state before mount
    const mcpStore = useMcpStore();
    // We need to trigger loading indirectly. We'll start a fetch that
    // never resolves, then mount.
    let neverResolve: () => void;
    const hangingPromise = new Promise<McpToolsResponse>((_resolve) => {
      neverResolve = () => {};
    });
    vi.mocked(getMcpTools).mockReturnValue(hangingPromise);

    // Start fetch (will hang)
    const fetchPromise = mcpStore.fetchMcpData();

    const router = makeRouter();
    const wrapper = mount(DebugView, {
      global: {
        plugins: [createPinia(), router],
      },
    });
    await flushPromises();

    clickMcpTab(wrapper);
    await flushPromises();

    // Should show loading text
    const loadingEl = wrapper.find('.debug-loading');
    expect(loadingEl.exists()).toBe(true);
    expect(loadingEl.text()).toBe('Loading MCP tools...');

    // Cleanup
    neverResolve!();
    // Swallow the hanging fetch
    fetchPromise.catch(() => {});
  });

  // ── Empty / zero-server state ───────────────────────────────

  it('shows "No MCP servers configured" when serverCount is 0', async () => {
    // Pre-populate with empty data so the tab click fetch resolves
    // to empty, leaving serverCount at 0.
    setActivePinia(createPinia());
    const mcpStore = useMcpStore();
    vi.mocked(getMcpTools).mockResolvedValue(mockEmptyResponse);
    await mcpStore.fetchMcpData();

    // Now reset the mock so the tab-click fetch also resolves to empty
    vi.mocked(getMcpTools).mockResolvedValue(mockEmptyResponse);

    const router = makeRouter();
    const wrapper = mount(DebugView, {
      global: {
        plugins: [createPinia(), router],
      },
    });
    await flushPromises();

    clickMcpTab(wrapper);
    await flushPromises();

    const emptyEl = wrapper.find('.debug-empty');
    expect(emptyEl.exists()).toBe(true);
    expect(emptyEl.text()).toBe('No MCP servers configured or running.');
  });

  // ── Summary section ─────────────────────────────────────────

  it('displays MCP summary counts: servers, tools, invocations, errors', async () => {
    const wrapper = await mountDebugViewWithMcpData(mockRichResponse);
    clickMcpTab(wrapper);
    await flushPromises();

    const gridItems = wrapper.findAll('.dg-item');
    const gridTexts = gridItems.map((el) => el.text());

    // Servers: 2
    expect(gridTexts.some((t) => t.includes('Servers:') && t.includes('2'))).toBe(true);
    // Tools: 3
    expect(gridTexts.some((t) => t.includes('Tools:') && t.includes('3'))).toBe(true);
    // Invocations: 65 (42 + 15 + 8) and errors: 3 (2 + 0 + 1)
    expect(gridTexts.some((t) => t.includes('Invocations:') && t.includes('65') && t.includes('3 errors'))).toBe(true);
    // Last Refreshed
    expect(gridTexts.some((t) => t.includes('Last Refreshed:'))).toBe(true);
  });

  it('shows invocations with zero errors when no errors exist', async () => {
    const noErrResponse: McpToolsResponse = {
      tools: [{ name: 't', inputSchema: { type: 'object' } }],
      servers: ['s'],
      invocationStats: { 's:t': { total: 10, success: 10, error: 0 } },
      serverDetails: [{
        name: 's', transport: 'stdio', status: 'running', toolCount: 1,
        tools: [{ name: 't', inputSchema: { type: 'object' as const }, stats: { total: 10, success: 10, error: 0 } }],
      }],
    };
    const wrapper = await mountDebugViewWithMcpData(noErrResponse);
    clickMcpTab(wrapper);
    await flushPromises();

    const gridItems = wrapper.findAll('.dg-item');
    const gridTexts = gridItems.map((el) => el.text());
    expect(gridTexts.some((t) => t.includes('Invocations:') && t.includes('10') && t.includes('0 errors'))).toBe(true);
  });

  // ── Per-server rendering ────────────────────────────────────

  it('renders per-server sections with status badge, transport, and tool count', async () => {
    const wrapper = await mountDebugViewWithMcpData(mockRichResponse);
    clickMcpTab(wrapper);
    await flushPromises();

    const sectionTitles = wrapper.findAll('.debug-section-title');
    const titleTexts = sectionTitles.map((t) => t.text());

    // First server: "filesystem" with badge, transport, tool count
    expect(titleTexts.some((t) => t.includes('filesystem'))).toBe(true);
    // Second server: "web"
    expect(titleTexts.some((t) => t.includes('web'))).toBe(true);

    // Status badges
    const serverBadges = wrapper.findAll('.mcp-server-badge');
    const badgeTexts = serverBadges.map((b) => b.text());
    expect(badgeTexts.filter((t) => t === 'running')).toHaveLength(2);

    // Transport labels
    const transports = wrapper.findAll('.mcp-server-transport');
    const transportTexts = transports.map((t) => t.text());
    expect(transportTexts).toContain('stdio');
    expect(transportTexts).toContain('sse');

    // Tool counts
    const toolCounts = wrapper.findAll('.mcp-tool-count');
    const tcTexts = toolCounts.map((t) => t.text());
    expect(tcTexts).toContain('2 tools');
    expect(tcTexts).toContain('1 tools');
  });

  it('renders server with error status badge', async () => {
    const wrapper = await mountDebugViewWithMcpData(mockServerErrorState);
    clickMcpTab(wrapper);
    await flushPromises();

    const serverBadges = wrapper.findAll('.mcp-server-badge');
    const badgeTexts = serverBadges.map((b) => b.text());
    expect(badgeTexts).toContain('error');

    // Verify the error badge has the correct CSS class
    const errorBadge = serverBadges.find((b) => b.text() === 'error');
    expect(errorBadge?.classes()).toContain('mcp-status-error');
  });

  it('shows "No tools discovered." message for server with zero tools', async () => {
    const wrapper = await mountDebugViewWithMcpData(mockServerRunningNoTools);
    clickMcpTab(wrapper);
    await flushPromises();

    // There should be a "No tools discovered." message inside the server section
    const emptyEls = wrapper.findAll('.debug-empty');
    const emptyTexts = emptyEls.map((e) => e.text());
    expect(emptyTexts.some((t) => t.includes('No tools discovered'))).toBe(true);
  });

  // ── Per-tool rendering ──────────────────────────────────────

  it('renders tool cards with name, description, and stats', async () => {
    const wrapper = await mountDebugViewWithMcpData(mockRichResponse);
    clickMcpTab(wrapper);
    await flushPromises();

    const toolCards = wrapper.findAll('.mcp-tool-card');
    // 3 tools across 2 servers
    expect(toolCards).toHaveLength(3);

    // First tool: read_file
    const firstCard = toolCards[0];
    expect(firstCard.find('.mcp-tool-name').text()).toBe('read_file');
    expect(firstCard.find('.mcp-tool-desc').text()).toBe('Read a file');

    // Check stats: total 42, success 40, error 2
    const stats = firstCard.findAll('.mcp-stat-item');
    const statTexts = stats.map((s) => s.text());
    expect(statTexts.some((t) => t.includes('42'))).toBe(true);
    expect(statTexts.some((t) => t.includes('✓') && t.includes('40'))).toBe(true);
    expect(statTexts.some((t) => t.includes('✗') && t.includes('2'))).toBe(true);
  });

  it('renders success/error stats with correct CSS classes', async () => {
    const wrapper = await mountDebugViewWithMcpData(mockRichResponse);
    clickMcpTab(wrapper);
    await flushPromises();

    const successStats = wrapper.findAll('.mcp-stat-success');
    expect(successStats.length).toBeGreaterThan(0);

    const errorStats = wrapper.findAll('.mcp-stat-error');
    expect(errorStats.length).toBeGreaterThan(0);
  });

  it('renders tool with missing description as "No description"', async () => {
    const noDescResponse: McpToolsResponse = {
      tools: [{ name: 'bare_tool', inputSchema: { type: 'object' } }],
      servers: ['s'],
      invocationStats: {},
      serverDetails: [{
        name: 's', transport: 'stdio', status: 'running', toolCount: 1,
        tools: [{
          name: 'bare_tool',
          // description intentionally omitted
          inputSchema: { type: 'object' as const },
          stats: { total: 0, success: 0, error: 0 },
        }],
      }],
    };
    const wrapper = await mountDebugViewWithMcpData(noDescResponse);
    clickMcpTab(wrapper);
    await flushPromises();

    const toolDesc = wrapper.find('.mcp-tool-desc');
    expect(toolDesc.text()).toBe('No description');
  });

  // ── Invocation stats table ──────────────────────────────────

  it('renders the "All Invocation Stats" table when invocationStats is non-empty', async () => {
    const wrapper = await mountDebugViewWithMcpData(mockRichResponse);
    clickMcpTab(wrapper);
    await flushPromises();

    const sectionTitles = wrapper.findAll('.debug-section-title');
    const titleTexts = sectionTitles.map((t) => t.text());
    expect(titleTexts).toContain('All Invocation Stats');

    // Table header
    const headerCells = wrapper.findAll('.mcp-stats-header .mcp-stats-cell');
    const headerTexts = headerCells.map((c) => c.text());
    expect(headerTexts).toContain('Key');
    expect(headerTexts).toContain('Total');
    expect(headerTexts).toContain('Success');
    expect(headerTexts).toContain('Error');
    expect(headerTexts).toContain('Last');

    // Rows
    const rows = wrapper.findAll('.mcp-stats-row');
    expect(rows).toHaveLength(3); // 3 tools = 3 rows
  });

  it('renders invocation stats row with correct values', async () => {
    const wrapper = await mountDebugViewWithMcpData(mockRichResponse);
    clickMcpTab(wrapper);
    await flushPromises();

    const rows = wrapper.findAll('.mcp-stats-row');
    // Row for 'filesystem:read_file'
    const rowText = rows[0].text();
    expect(rowText).toContain('filesystem:read_file');
    expect(rowText).toContain('42');
    expect(rowText).toContain('40');
    expect(rowText).toContain('2');
  });

  it('does not render "All Invocation Stats" when invocationStats is empty', async () => {
    const wrapper = await mountDebugViewWithMcpData(mockServerRunningNoTools);
    clickMcpTab(wrapper);
    await flushPromises();

    const sectionTitles = wrapper.findAll('.debug-section-title');
    const titleTexts = sectionTitles.map((t) => t.text());
    expect(titleTexts).not.toContain('All Invocation Stats');
  });

  // ── Multiple servers rendering ──────────────────────────────

  it('renders tool cards grouped under their respective server sections', async () => {
    const wrapper = await mountDebugViewWithMcpData(mockRichResponse);
    clickMcpTab(wrapper);
    await flushPromises();

    // We have 2 server sections, each with a .debug-section-title h4
    // that contains the server name. Find the server sections by targeting
    // the section titles that include the server names.
    const allSections = wrapper.findAll('.debug-section');
    expect(allSections.length).toBeGreaterThanOrEqual(3); // Summary + filesystem + web (+ possibly All Invocation Stats)

    // Find the section whose h4 contains "filesystem" (exact server-name match in title)
    const filesystemSection = allSections.find((s) => {
      const h4 = s.find('.debug-section-title');
      return h4.exists() && h4.text().startsWith('filesystem');
    });
    expect(filesystemSection).toBeTruthy();
    expect(filesystemSection!.findAll('.mcp-tool-card')).toHaveLength(2);

    // Find the section whose h4 contains "web" as a server name (starts with "web")
    const webSection = allSections.find((s) => {
      const h4 = s.find('.debug-section-title');
      return h4.exists() && h4.text().startsWith('web');
    });
    expect(webSection).toBeTruthy();
    expect(webSection!.findAll('.mcp-tool-card')).toHaveLength(1);
  });
});
