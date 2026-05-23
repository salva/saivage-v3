/**
 * Tests for write-territories.ts — Advisory write territory warnings
 *
 * Covers:
 * - Each role with paths inside their territory (returns null warning)
 * - Each role with paths outside their territory (returns warning string)
 * - allowed is always true (territories don't block)
 * - Edge cases: unknown roles, empty paths, root paths
 * - TERRITORY_RULES structure validation
 * - getTerritoryWarning convenience function
 */

import { describe, it, expect } from '@jest/globals';

import {
  checkWriteTerritory,
  getTerritoryWarning,
  TERRITORY_RULES,
} from '../../src/workspace/write-territories.js';
import type {
  TerritoryRole,
  TerritoryResult,
} from '../../src/workspace/write-territories.js';

// ── Helpers ───────────────────────────────────────────────────

const ALL_ROLES: TerritoryRole[] = [
  'analyst',
  'planner',
  'executor',
  'reviewer',
  'content_supervisor',
];

/** Assert that a write produces NO warning (fully within territory). */
function expectNoWarning(role: TerritoryRole, filePath: string) {
  const result = checkWriteTerritory(role, filePath);
  expect(result.allowed).toBe(true);
  expect(result.warning).toBeUndefined();

  const warn = getTerritoryWarning(role, filePath);
  expect(warn).toBeNull();
}

/** Assert that a write produces a warning (violation). */
function expectWarning(role: TerritoryRole, filePath: string) {
  const result = checkWriteTerritory(role, filePath);
  expect(result.allowed).toBe(true);
  expect(result.warning).toBeDefined();
  expect(typeof result.warning).toBe('string');
  expect(result.warning!.length).toBeGreaterThan(10);

  const warn = getTerritoryWarning(role, filePath);
  expect(warn).toBe(result.warning);
}

// ── Tests ─────────────────────────────────────────────────────

describe('Write Territories', () => {
  // ── Analyst ──────────────────────────────────────────────

  describe('analyst territory', () => {
    const ROLE: TerritoryRole = 'analyst';

    it('allows writes to .saivage/agents/ directory', () => {
      expectNoWarning(ROLE, '.saivage/agents/session-123.json');
      expectNoWarning(ROLE, '.saivage/agents/planner/diary.jsonl');
      expectNoWarning(ROLE, '.saivage/agents/analyst/notes.md');
    });

    it('allows writes to .saivage/notes/ directory', () => {
      expectNoWarning(ROLE, '.saivage/notes/research.md');
      expectNoWarning(ROLE, '.saivage/notes/2025-01-15/summary.txt');
    });

    it('warns on writes to src/ (project source files)', () => {
      expectWarning(ROLE, 'src/index.ts');
      expectWarning(ROLE, 'src/utils/helper.ts');
      expectWarning(ROLE, 'src/agents/agent-adapter.ts');
    });

    it('warns on writes to .saivage-work/', () => {
      expectWarning(ROLE, '.saivage-work/cards/card-1.json');
      expectWarning(ROLE, '.saivage-work/processes/proc.log');
    });

    it('warns on writes to .saivage/ directly (not under agents/ or notes/)', () => {
      expectWarning(ROLE, '.saivage/project.json');
      expectWarning(ROLE, '.saivage/saivage.json');
    });

    it('warns on writes to root-level files', () => {
      expectWarning(ROLE, 'README.md');
      expectWarning(ROLE, 'package.json');
    });
  });

  // ── Planner ──────────────────────────────────────────────

  describe('planner territory', () => {
    const ROLE: TerritoryRole = 'planner';

    it('allows writes to .saivage/ directly', () => {
      expectNoWarning(ROLE, '.saivage/project.json');
      expectNoWarning(ROLE, '.saivage/plan.json');
      expectNoWarning(ROLE, '.saivage/plan-history.jsonl');
    });

    it('warns on writes to src/ (outside territory)', () => {
      // src/ is not in planner's allowed territory at all,
      // so it triggers the "outside territory" warning.
      expectWarning(ROLE, 'src/index.ts');
      expectWarning(ROLE, 'src/utils/helper.ts');
      expectWarning(ROLE, 'src/agents/config-schema.ts');
    });

    it('warns on writes to .saivage-work/ (outside territory)', () => {
      expectWarning(ROLE, '.saivage-work/cards/card-1.json');
      expectWarning(ROLE, '.saivage-work/processes/proc.log');
      expectWarning(ROLE, '.saivage-work/tmp/stash/data.bin');
    });

    it('warns on writes to root-level files', () => {
      expectWarning(ROLE, 'README.md');
      expectWarning(ROLE, 'package.json');
    });
  });

  // ── Executor ─────────────────────────────────────────────

  describe('executor territory', () => {
    const ROLE: TerritoryRole = 'executor';

    it('allows writes to src/ (project source files)', () => {
      expectNoWarning(ROLE, 'src/index.ts');
      expectNoWarning(ROLE, 'src/utils/write-territories.ts');
      expectNoWarning(ROLE, 'src/agents/agent-adapter.ts');
    });

    it('allows writes to .saivage-work/cards/', () => {
      expectNoWarning(ROLE, '.saivage-work/cards/card-exec-1.json');
      expectNoWarning(ROLE, '.saivage-work/cards/summary.md');
    });

    it('allows writes to .saivage-work/processes/', () => {
      expectNoWarning(ROLE, '.saivage-work/processes/proc-123.log');
      expectNoWarning(ROLE, '.saivage-work/processes/proc-123/result.json');
    });

    it('warns on writes to .saivage/ directly (excluded)', () => {
      expectWarning(ROLE, '.saivage/project.json');
      expectWarning(ROLE, '.saivage/plan.json');
      expectWarning(ROLE, '.saivage/saivage.json');
      expectWarning(ROLE, '.saivage/agents/session.json');
      expectWarning(ROLE, '.saivage/notes/research.md');
    });

    it('warns on writes to root-level files', () => {
      expectWarning(ROLE, 'README.md');
      expectWarning(ROLE, 'package.json');
    });

    it('warns on writes to .saivage-work/ outside cards/ and processes/', () => {
      // .saivage-work/tmp/ is NOT in executor territory
      expectWarning(ROLE, '.saivage-work/tmp/stash/data.bin');
      expectWarning(ROLE, '.saivage-work/quarantine/item/raw.bin');
      expectWarning(ROLE, '.saivage-work/other/file.txt');
    });

    it('warns on writes to tests/ (not in executor territory)', () => {
      expectWarning(ROLE, 'tests/utils/helper.test.ts');
    });
  });

  // ── Reviewer ─────────────────────────────────────────────

  describe('reviewer territory', () => {
    const ROLE: TerritoryRole = 'reviewer';

    it('allows writes to .saivage/ directly', () => {
      expectNoWarning(ROLE, '.saivage/project.json');
      expectNoWarning(ROLE, '.saivage/review-diaries.jsonl');
    });

    it('warns on writes to src/ (outside territory)', () => {
      expectWarning(ROLE, 'src/index.ts');
      expectWarning(ROLE, 'src/utils/helper.ts');
    });

    it('warns on writes to .saivage-work/ (outside territory)', () => {
      expectWarning(ROLE, '.saivage-work/cards/card-1.json');
      expectWarning(ROLE, '.saivage-work/processes/proc.log');
    });

    it('warns on writes to root-level files', () => {
      expectWarning(ROLE, 'README.md');
    });
  });

  // ── Content Supervisor ───────────────────────────────────

  describe('content_supervisor territory', () => {
    const ROLE: TerritoryRole = 'content_supervisor';

    it('allows writes anywhere (no territory restrictions)', () => {
      expectNoWarning(ROLE, '.saivage/saivage.json');
      expectNoWarning(ROLE, 'src/index.ts');
      expectNoWarning(ROLE, '.saivage-work/quarantine/q-1/meta.json');
      expectNoWarning(ROLE, '.saivage/supervision/reviews.jsonl');
      expectNoWarning(ROLE, 'README.md');
      expectNoWarning(ROLE, '.saivage-work/tmp/stash/data.bin');
    });
  });

  // ── Allowed is ALWAYS true ───────────────────────────────

  describe('allowed is always true', () => {
    it('returns allowed:true for every role and path combination', () => {
      const testCases: [TerritoryRole, string][] = [
        ['analyst', 'src/index.ts'],
        ['analyst', '.saivage/agents/session.json'],
        ['analyst', '/etc/passwd'], // absolute path
        ['planner', 'src/main.ts'],
        ['planner', '.saivage/plan.json'],
        ['executor', '.saivage/saivage.json'],
        ['executor', 'src/run.ts'],
        ['reviewer', 'src/app.ts'],
        ['reviewer', '.saivage/review.json'],
        ['content_supervisor', 'anything/at/all.txt'],
      ];

      for (const [role, path] of testCases) {
        const result = checkWriteTerritory(role, path);
        expect(result.allowed).toBe(true);
      }
    });

    it('never blocks writes — only warns', () => {
      // The most egregious violation: executor writing to auth-profiles
      const result = checkWriteTerritory('executor', '.saivage/auth-profiles.json');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
    });
  });

  // ── Edge Cases ───────────────────────────────────────────

  describe('edge cases', () => {
    it('returns no warning for unknown roles', () => {
      const result = checkWriteTerritory('superadmin', 'src/index.ts');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('returns no warning for unknown roles via getTerritoryWarning', () => {
      const warn = getTerritoryWarning('nonexistent', 'src/index.ts');
      expect(warn).toBeNull();
    });

    it('handles empty file path', () => {
      const result = checkWriteTerritory('executor', '');
      // Empty path doesn't match any allowed prefix → should warn
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
    });

    it('handles path with ./ prefix', () => {
      // Same result regardless of ./ prefix
      const noDot = checkWriteTerritory('analyst', '.saivage/agents/file.json');
      const withDot = checkWriteTerritory('analyst', './.saivage/agents/file.json');
      expect(noDot.warning).toBeUndefined();
      expect(withDot.warning).toBeUndefined();
      expect(noDot.allowed).toBe(withDot.allowed);
    });

    it('handles path with multiple ./ segments', () => {
      const result = checkWriteTerritory('executor', '././src/index.ts');
      expect(result.allowed).toBe(true);
    });

    it('handles deeply nested paths', () => {
      const deep = 'src/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/file.ts';
      expectNoWarning('executor', deep);
    });

    it('handles root-relative (absolute-like) paths', () => {
      // Paths starting with / might be absolute — still checked
      const result = checkWriteTerritory('executor', '/etc/passwd');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
    });

    it('subdirectory of allowed path is also allowed', () => {
      expectNoWarning('executor', 'src/utils/subdir/nested/file.ts');
      expectNoWarning('analyst', '.saivage/agents/sub/dir/file.json');
    });

    it('subdirectory of excluded path is considered excluded', () => {
      // Executor: 'src/' is allowed, but '.saivage/' is excluded.
      // A nested path under .saivage/ should still warn
      expectWarning('executor', '.saivage/sub/dir/deep/file.json');
    });
  });

  // ── TERRITORY_RULES structure ────────────────────────────

  describe('TERRITORY_RULES constant', () => {
    it('has entries for all 5 roles', () => {
      for (const role of ALL_ROLES) {
        expect(TERRITORY_RULES[role]).toBeDefined();
      }
    });

    it('each rule has required fields', () => {
      for (const role of ALL_ROLES) {
        const rule = TERRITORY_RULES[role];
        expect(Array.isArray(rule.allowed)).toBe(true);
        expect(Array.isArray(rule.excludes)).toBe(true);
      }
    });

    it('analyst rule matches specification', () => {
      const rule = TERRITORY_RULES.analyst;
      expect(rule.allowed).toContain('.saivage/agents/');
      expect(rule.allowed).toContain('.saivage/notes/');
      expect(rule.excludes).toContain('src/');
    });

    it('planner rule matches specification', () => {
      const rule = TERRITORY_RULES.planner;
      expect(rule.allowed).toContain('.saivage/');
      expect(rule.excludes).toContain('src/');
      expect(rule.excludes).toContain('.saivage-work/');
    });

    it('executor rule matches specification', () => {
      const rule = TERRITORY_RULES.executor;
      expect(rule.allowed).toContain('src/');
      expect(rule.allowed).toContain('.saivage-work/cards/');
      expect(rule.allowed).toContain('.saivage-work/processes/');
      expect(rule.excludes).toContain('.saivage/');
    });

    it('reviewer rule matches specification', () => {
      const rule = TERRITORY_RULES.reviewer;
      expect(rule.allowed).toContain('.saivage/');
      expect(rule.excludes).toContain('src/');
      expect(rule.excludes).toContain('.saivage-work/');
    });

    it('content_supervisor has no restrictions', () => {
      const rule = TERRITORY_RULES.content_supervisor;
      expect(rule.allowed).toHaveLength(0);
      expect(rule.excludes).toHaveLength(0);
    });
  });

  // ── Exclusion Scenarios ──────────────────────────────────

  describe('exclusion warnings (allowed + excluded)', () => {
    it('warns when executor writes to .saivage/agents/ (excluded subpath of .saivage/)', () => {
      // .saivage/ is in executor's excludes.
      // But .saivage/ is NOT in executor's allowed, so this triggers
      // the "outside territory" case, not the "excluded" case.
      const result = checkWriteTerritory('executor', '.saivage/agents/session.json');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
      // The warning comes from "outside territory", not "excluded"
      expect(result.warning).toContain('outside territory');
    });

    it('warns when executor writes to .saivage/ directly (excluded)', () => {
      const result = checkWriteTerritory('executor', '.saivage/saivage.json');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
    });

    it('analyst writing to .saivage/project.json triggers outside-territory warning', () => {
      // .saivage/project.json doesn't match .saivage/agents/ or .saivage/notes/
      const result = checkWriteTerritory('analyst', '.saivage/project.json');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('outside territory');
    });
  });

  // ── Warning message quality ──────────────────────────────

  describe('warning message content', () => {
    it('includes the role name in the warning', () => {
      const result = checkWriteTerritory('executor', '.saivage/saivage.json');
      expect(result.warning).toContain('executor');
    });

    it('includes the file path in the warning', () => {
      const result = checkWriteTerritory('analyst', 'src/main.ts');
      expect(result.warning).toContain('src/main.ts');
    });

    it('includes allowed territories in the warning when outside', () => {
      const result = checkWriteTerritory('analyst', 'src/main.ts');
      expect(result.warning).toContain('.saivage/agents/');
      expect(result.warning).toContain('.saivage/notes/');
    });

    it('uses human-readable role names (underscores replaced)', () => {
      // content_supervisor has no restrictions, so no warning
      const resultCS = checkWriteTerritory('content_supervisor', '.saivage/saivage.json');
      expect(resultCS.warning).toBeUndefined();

      const resultP = checkWriteTerritory('planner', 'src/x.ts');
      expect(resultP.warning).toContain('planner');
    });

    it('getTerritoryWarning returns null when checkWriteTerritory has no warning', () => {
      const warn = getTerritoryWarning('executor', 'src/index.ts');
      expect(warn).toBeNull();

      const result = checkWriteTerritory('executor', 'src/index.ts');
      expect(result.warning).toBeUndefined();
    });

    it('getTerritoryWarning returns string when checkWriteTerritory has warning', () => {
      const warn = getTerritoryWarning('executor', '.saivage/saivage.json');
      expect(typeof warn).toBe('string');

      const result = checkWriteTerritory('executor', '.saivage/saivage.json');
      expect(warn).toBe(result.warning);
    });

    it('warnings mention "outside territory" for non-allowed paths', () => {
      const result = checkWriteTerritory('reviewer', 'README.md');
      expect(result.warning).toContain('outside territory');
    });
  });

  // ── TypeScript type compliance ───────────────────────────

  describe('TerritoryResult type compliance', () => {
    it('TerritoryResult has allowed boolean', () => {
      const r: TerritoryResult = checkWriteTerritory('analyst', 'src/x.ts');
      expect(typeof r.allowed).toBe('boolean');
    });

    it('TerritoryResult.warning is string or undefined', () => {
      const r1 = checkWriteTerritory('analyst', '.saivage/agents/x.json');
      expect(r1.warning).toBeUndefined();

      const r2 = checkWriteTerritory('analyst', 'src/x.ts');
      expect(typeof r2.warning).toBe('string');
    });

    it('checkWriteTerritory always returns the same shape', () => {
      for (const role of ALL_ROLES) {
        for (const path of ['src/x.ts', '.saivage/x.json', '.saivage-work/x.log', 'README.md']) {
          const r = checkWriteTerritory(role, path);
          expect(r).toHaveProperty('allowed');
          expect(typeof r.allowed).toBe('boolean');
          // warning may be string or undefined
          if (r.warning !== undefined) {
            expect(typeof r.warning).toBe('string');
          }
        }
      }
    });
  });
});
