/**
 * Bounded component-level regression tests for the DebugView
 * supervision/doctor tab behaviour.
 *
 * These tests mount the DebugView component using Vue Test Utils +
 * jsdom and verify that the supervision tab renders expected
 * elements when the debug store contains supervision data.
 *
 * The API client is fully mocked — no server needed.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import DebugView from '../views/DebugView.vue';
import { useDebugStore } from '../stores/debug';

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

vi.mock('../stores/liveSync', () => ({
  useLiveSyncStore: () => ({
    registerResource: vi.fn(() => vi.fn()),
    openConversation: vi.fn(() => vi.fn()),
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

import {
  getDoctor,
  getDebugSupervision,
} from '../api/client';

// ── Fixtures ──────────────────────────────────────────────────

const mockDoctorOk = {
  status: 'ok' as const,
  checks: [
    { name: 'card-index-integrity', passed: true, details: 'All consistent' },
    { name: 'orphan-detection', passed: true },
  ],
  issues: [] as Array<{ severity: 'error' | 'warning'; message: string }>,
};

const mockSupervision = {
  reviews: [
    {
      id: 'r1',
      source_kind: 'command_output' as const,
      source_ref: 'proc-1/stdout',
      status: 'passed' as const,
      summary: 'No issues',
      risk: 'low' as const,
      quarantine_id: null,
      created_at: '2025-06-01T10:00:00Z',
    },
    {
      id: 'r2',
      source_kind: 'file' as const,
      source_ref: 'report.md',
      status: 'blocked' as const,
      summary: 'PII found',
      risk: 'high' as const,
      quarantine_id: 'q-blocked',
      created_at: '2025-06-01T10:05:00Z',
    },
  ],
  quarantine: [
    {
      quarantine_id: 'q-blocked',
      review_id: 'r2',
      source_ref: 'report.md',
      risk: 'high' as const,
      created_at: '2025-06-01T10:05:00Z',
    },
  ],
  stats: {
    total: 2,
    blocked: 1,
    passed: 1,
    sanitized: 0,
    byRisk: { low: 1, high: 1 },
    bySourceKind: { command_output: 1, file: 1 },
  },
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

// ── Mount helper ──────────────────────────────────────────────

async function mountDebugView() {
  setActivePinia(createPinia());

  // Pre-populate the debug store with supervision data so the
  // supervision tab renders immediately after clicking it.
  const debugStore = useDebugStore();
  vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
  vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervision);
  await debugStore.fetchDoctor();
  await debugStore.fetchSupervision();

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

function clickSupervisionTab(wrapper: ReturnType<typeof mount>) {
  const tabs = wrapper.findAll('.debug-tab-button');
  const supervisionTab = tabs.find((t) => t.text() === 'Supervision');
  if (supervisionTab) {
    supervisionTab.trigger('click');
  }
}

// ── Tests ─────────────────────────────────────────────────────

describe('DebugView — supervision tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    // Pre-resolve mocks so onMounted fetchAll doesn't cause unhandled rejections
    vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
    vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervision);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Supervision tab button', async () => {
    const wrapper = await mountDebugView();
    const tabs = wrapper.findAll('.debug-tab-button');
    const labels = tabs.map((t) => t.text());
    expect(labels).toContain('Supervision');
  });

  it('shows doctor diagnostics section when Supervision tab is active', async () => {
    const wrapper = await mountDebugView();
    clickSupervisionTab(wrapper);
    await flushPromises();

    const doctorTitle = wrapper.find('.debug-section-title');
    expect(doctorTitle.text()).toBe('Doctor Diagnostics');
  });

  it('displays doctor "All checks passed" banner when status is ok', async () => {
    const wrapper = await mountDebugView();
    clickSupervisionTab(wrapper);
    await flushPromises();

    const banner = wrapper.find('.doctor-status-banner');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain('All checks passed');
    expect(banner.classes()).toContain('doctor-ok');
  });

  it('renders doctor check items', async () => {
    const wrapper = await mountDebugView();
    clickSupervisionTab(wrapper);
    await flushPromises();

    const checks = wrapper.findAll('.doctor-check-item');
    expect(checks).toHaveLength(2);
    expect(checks[0].text()).toContain('card-index-integrity');
    expect(checks[0].classes()).toContain('check-passed');
  });

  it('shows Content Supervision section title', async () => {
    const wrapper = await mountDebugView();
    clickSupervisionTab(wrapper);
    await flushPromises();

    const sectionTitles = wrapper.findAll('.debug-section-title');
    const titles = sectionTitles.map((t) => t.text());
    expect(titles).toContain('Content Supervision');
  });

  it('displays supervision stats grid with correct numbers', async () => {
    const wrapper = await mountDebugView();
    clickSupervisionTab(wrapper);
    await flushPromises();

    const statCards = wrapper.findAll('.sv-stat-card');
    expect(statCards).toHaveLength(4);

    const statNums = wrapper.findAll('.sv-stat-num');
    const nums = statNums.map((n) => n.text());
    // "2" total, "1" blocked, "1" passed, "0" sanitized
    expect(nums).toContain('2');
    expect(nums).toContain('1');
    expect(nums).toContain('0');
  });

  it('renders By Risk pills', async () => {
    const wrapper = await mountDebugView();
    clickSupervisionTab(wrapper);
    await flushPromises();

    const riskPills = wrapper.findAll('.sv-pill.risk-low, .sv-pill.risk-high');
    expect(riskPills.length).toBeGreaterThanOrEqual(2);
    const pillTexts = riskPills.map((p) => p.text());
    expect(pillTexts.some((t) => t.includes('low'))).toBe(true);
    expect(pillTexts.some((t) => t.includes('high'))).toBe(true);
  });

  it('renders By Source pills', async () => {
    const wrapper = await mountDebugView();
    clickSupervisionTab(wrapper);
    await flushPromises();

    const kindPills = wrapper.findAll('.sv-pill-kind');
    expect(kindPills.length).toBeGreaterThanOrEqual(2);
    const pillTexts = kindPills.map((p) => p.text());
    expect(pillTexts.some((t) => t.includes('command_output'))).toBe(true);
    expect(pillTexts.some((t) => t.includes('file'))).toBe(true);
  });

  it('renders review items with status badges', async () => {
    const wrapper = await mountDebugView();
    clickSupervisionTab(wrapper);
    await flushPromises();

    const reviews = wrapper.findAll('.sv-review-item');
    expect(reviews).toHaveLength(2);

    // First review: passed
    expect(reviews[0].classes()).toContain('sv-review-passed');
    expect(reviews[0].find('.sv-review-summary').text()).toBe('No issues');

    // Second review: blocked
    expect(reviews[1].classes()).toContain('sv-review-blocked');
    expect(reviews[1].find('.sv-review-summary').text()).toBe('PII found');
  });

  it('renders quarantine entry with Browse in Files button', async () => {
    const wrapper = await mountDebugView();
    clickSupervisionTab(wrapper);
    await flushPromises();

    const qItems = wrapper.findAll('.sv-q-item');
    expect(qItems).toHaveLength(1);
    expect(qItems[0].text()).toContain('q-blocked');

    const browseBtn = qItems[0].find('.sv-q-browse-btn');
    expect(browseBtn.exists()).toBe(true);
    expect(browseBtn.text()).toBe('Browse in Files');
  });

  it('navigates to Files route on quarantine Browse click', async () => {
    const wrapper = await mountDebugView();
    clickSupervisionTab(wrapper);
    await flushPromises();

    const browseBtn = wrapper.find('.sv-q-browse-btn');
    await browseBtn.trigger('click');
    await flushPromises();

    expect(mockPush).toHaveBeenCalledWith({
      name: 'files',
      query: { path: '.saivage/work/quarantine/q-blocked' },
    });
  });
});
