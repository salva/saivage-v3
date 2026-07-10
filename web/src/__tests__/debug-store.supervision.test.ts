/**
 * Bounded client-layer regression tests for the debug store's
 * supervision/doctor data fetching, state transitions, and computed
 * getter correctness.
 *
 * These tests mock the API client layer (`../api/client`) so we verify
 * store-side logic without requiring a running Saivage server.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useDebugStore } from '../stores/debug';

// ── Mock the API client ───────────────────────────────────────
// We only mock the functions the debug store actually imports.
vi.mock('../api/client', () => ({
  getDoctor: vi.fn(),
  getDebugSupervision: vi.fn(),
  getDebugState: vi.fn(),
  getDebugErrors: vi.fn(),
  getDebugTimeline: vi.fn(),
  listProcesses: vi.fn(),
  ApiError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import {
  getDoctor,
  getDebugSupervision,
} from '../api/client';

// ── Helpers ───────────────────────────────────────────────────

function setupStore() {
  setActivePinia(createPinia());
  return useDebugStore();
}

// ── Doctor fixtures ───────────────────────────────────────────

const mockDoctorOk = {
  status: 'ok' as const,
  checks: [
    { name: 'card-index-integrity', passed: true, details: 'All 42 cards are consistent' },
    { name: 'file-metadata-count', passed: true },
    { name: 'orphan-detection', passed: true, details: 'No orphans found' },
  ],
  issues: [] as Array<{ severity: 'error' | 'warning'; message: string }>,
};

const mockDoctorIssues = {
  status: 'issues_found' as const,
  checks: [
    { name: 'card-index-integrity', passed: false, details: '3 cards missing from index' },
    { name: 'file-metadata-count', passed: true },
    { name: 'orphan-detection', passed: false, details: '2 orphan files' },
  ],
  issues: [
    { severity: 'error' as const, message: 'Card #abc referenced by card #def but not found' },
    { severity: 'warning' as const, message: 'Orphan file .saivage/work/output/xyz.log' },
  ],
};

// ── Supervision fixtures ──────────────────────────────────────

const mockSupervision = {
  reviews: [
    {
      id: 'r1',
      source_kind: 'command_output' as const,
      source_ref: 'proc-1/stdout',
      status: 'passed' as const,
      summary: 'No sensitive data detected',
      risk: 'low' as const,
      created_at: '2025-06-01T10:00:00Z',
    },
    {
      id: 'r2',
      source_kind: 'file' as const,
      source_ref: '.saivage/work/output/report.md',
      status: 'blocked' as const,
      summary: 'Contains PII pattern (email)',
      risk: 'high' as const,
      created_at: '2025-06-01T10:05:00Z',
    },
    {
      id: 'r3',
      source_kind: 'download' as const,
      source_ref: 'https://example.com/data.csv',
      status: 'sanitized' as const,
      summary: 'PII redacted, content safe',
      risk: 'medium' as const,
      created_at: '2025-06-01T10:10:00Z',
    },
  ],
  stats: {
    total: 3,
    blocked: 1,
    passed: 1,
    sanitized: 1,
    byRisk: { low: 1, medium: 1, high: 1 },
    bySourceKind: { command_output: 1, file: 1, download: 1 },
  },
};

// ── Tests ─────────────────────────────────────────────────────

describe('useDebugStore — supervision/doctor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Doctor ──────────────────────────────────────────────────

  describe('fetchDoctor()', () => {
    it('sets doctorStatus, doctorChecks, and doctorIssues on success (ok)', async () => {
      const store = setupStore();
      vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);

      await store.fetchDoctor();

      expect(store.doctorStatus).toBe('ok');
      expect(store.doctorChecks).toHaveLength(3);
      expect(store.doctorChecks[0].name).toBe('card-index-integrity');
      expect(store.doctorIssues).toEqual([]);
      expect(store.doctorLoading).toBe(false);
      expect(store.error).toBeNull();
    });

    it('sets doctorStatus to issues_found with issues', async () => {
      const store = setupStore();
      vi.mocked(getDoctor).mockResolvedValue(mockDoctorIssues);

      await store.fetchDoctor();

      expect(store.doctorStatus).toBe('issues_found');
      expect(store.doctorChecks).toHaveLength(3);
      expect(store.doctorIssues).toHaveLength(2);
      expect(store.doctorIssues[0].severity).toBe('error');
    });

    it('sets doctorLoading=true while fetching', async () => {
      const store = setupStore();
      let resolve: (v: typeof mockDoctorOk) => void;
      const promise = new Promise<typeof mockDoctorOk>((r) => { resolve = r; });
      vi.mocked(getDoctor).mockReturnValue(promise);

      const fetchPromise = store.fetchDoctor();
      expect(store.doctorLoading).toBe(true);

      resolve!(mockDoctorOk);
      await fetchPromise;
      expect(store.doctorLoading).toBe(false);
    });

    it('sets error on fetch failure', async () => {
      const store = setupStore();
      vi.mocked(getDoctor).mockRejectedValue(new Error('Network error'));

      await store.fetchDoctor();

      expect(store.doctorStatus).toBeNull();
      expect(store.doctorError).toBe('Failed to fetch doctor diagnostics');
      expect(store.doctorLoading).toBe(false);
    });
  });

  // ── Supervision ─────────────────────────────────────────────

  describe('fetchSupervision()', () => {
    it('populates supervisionReviews and supervisionStats', async () => {
      const store = setupStore();
      vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervision);

      await store.fetchSupervision();

      expect(store.supervisionReviews).toHaveLength(3);
      expect(store.supervisionStats).toEqual(mockSupervision.stats);
      expect(store.supervisionLoading).toBe(false);
    });

    it('sets supervisionLoading=true while fetching', async () => {
      const store = setupStore();
      let resolve: (v: typeof mockSupervision) => void;
      const promise = new Promise<typeof mockSupervision>((r) => { resolve = r; });
      vi.mocked(getDebugSupervision).mockReturnValue(promise);

      const fetchPromise = store.fetchSupervision();
      expect(store.supervisionLoading).toBe(true);

      resolve!(mockSupervision);
      await fetchPromise;
      expect(store.supervisionLoading).toBe(false);
    });

    it('sets error on fetch failure', async () => {
      const store = setupStore();
      vi.mocked(getDebugSupervision).mockRejectedValue(new Error('Network error'));

      await store.fetchSupervision();

      expect(store.supervisionStats).toBeNull();
      expect(store.supervisionError).toBe('Failed to fetch supervision data');
      expect(store.supervisionLoading).toBe(false);
    });
  });
});
