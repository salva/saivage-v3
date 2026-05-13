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
    { severity: 'warning' as const, message: 'Orphan file .saivage-work/quarantine/xyz.log' },
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
      quarantine_id: null,
      created_at: '2025-06-01T10:00:00Z',
    },
    {
      id: 'r2',
      source_kind: 'file' as const,
      source_ref: '.saivage-work/output/report.md',
      status: 'blocked' as const,
      summary: 'Contains PII pattern (email)',
      risk: 'high' as const,
      quarantine_id: 'q-abc123',
      created_at: '2025-06-01T10:05:00Z',
    },
    {
      id: 'r3',
      source_kind: 'download' as const,
      source_ref: 'https://example.com/data.csv',
      status: 'sanitized' as const,
      summary: 'PII redacted, content safe',
      risk: 'medium' as const,
      quarantine_id: null,
      created_at: '2025-06-01T10:10:00Z',
    },
  ],
  quarantine: [
    {
      quarantine_id: 'q-abc123',
      review_id: 'r2',
      source_ref: '.saivage-work/output/report.md',
      risk: 'high' as const,
      created_at: '2025-06-01T10:05:00Z',
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
      expect(store.failedChecks).toHaveLength(2);
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
    it('populates supervisionReviews, supervisionQuarantine, and supervisionStats', async () => {
      const store = setupStore();
      vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervision);

      await store.fetchSupervision();

      expect(store.supervisionReviews).toHaveLength(3);
      expect(store.supervisionQuarantine).toHaveLength(1);
      expect(store.supervisionQuarantine[0].quarantine_id).toBe('q-abc123');
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

  // ── Computed getters ────────────────────────────────────────

  describe('reviewsByStatus', () => {
    it('groups reviews by status correctly', async () => {
      const store = setupStore();
      vi.mocked(getDebugSupervision).mockResolvedValue(mockSupervision);
      await store.fetchSupervision();

      const byStatus = store.reviewsByStatus;
      expect(byStatus.get('passed')).toHaveLength(1);
      expect(byStatus.get('blocked')).toHaveLength(1);
      expect(byStatus.get('sanitized')).toHaveLength(1);
    });
  });

  describe('failedChecks', () => {
    it('returns only failed doctor checks', async () => {
      const store = setupStore();
      vi.mocked(getDoctor).mockResolvedValue(mockDoctorIssues);
      await store.fetchDoctor();

      const failed = store.failedChecks;
      expect(failed).toHaveLength(2);
      expect(failed[0].name).toBe('card-index-integrity');
      expect(failed[1].name).toBe('orphan-detection');
    });

    it('returns empty array when all checks pass', async () => {
      const store = setupStore();
      vi.mocked(getDoctor).mockResolvedValue(mockDoctorOk);
      await store.fetchDoctor();

      expect(store.failedChecks).toEqual([]);
    });
  });

  describe('doctorIssuesBySeverity', () => {
    it('groups issues by severity', async () => {
      const store = setupStore();
      vi.mocked(getDoctor).mockResolvedValue(mockDoctorIssues);
      await store.fetchDoctor();

      const bySev = store.doctorIssuesBySeverity;
      expect(bySev.get('error')).toHaveLength(1);
      expect(bySev.get('warning')).toHaveLength(1);
    });
  });
});
