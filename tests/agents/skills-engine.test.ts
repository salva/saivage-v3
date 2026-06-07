import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsEngine } from '../../src/agents/skills-engine.js';
import {
  buildPlannerPrompt,
  buildExecutorPrompt,
  buildReviewerPrompt,
} from '../../src/agents/system-prompt.js';
import { createPlannerContract } from '../../src/contracts/planner-contract.js';
import { createExecutorContract } from '../../src/contracts/executor-contract.js';
import { createReviewerContract } from '../../src/contracts/reviewer-contract.js';
import type { SkillIndexEntry, AgentRole } from '../../src/schemas/types.js';

function makeEntry(overrides: Partial<SkillIndexEntry> = {}): SkillIndexEntry {
  return {
    name: 'test-skill',
    file: 'test-skill.md',
    target_agents: ['executor'] as AgentRole[],
    triggers: [{ type: 'keyword', pattern: 'test' }],
    updated_at: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

function indexJson(entries: SkillIndexEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

function mkParams(overrides: Record<string, unknown> = {}) {
  return {
    goalDescription: 'Build a test framework',
    cardDescription: 'Write comprehensive tests',
    tags: [] as string[],
    filePaths: [] as string[],
    availableTools: [] as string[],
    targetRole: 'executor',
    ...overrides,
  };
}

describe('SkillsEngine', () => {
  let tmpDir: string;
  let skillsDir: string;
  let engine: SkillsEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-skills-test-'));
    skillsDir = join(tmpDir, '.saivage', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    engine = new SkillsEngine({ projectRoot: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ═══════════════ Constructor & Configuration ═══════════════

  describe('Constructor & Configuration', () => {
    it('default topN is 5', () => { expect(engine.topN).toBe(5); });

    it('custom topN can be passed', () => {
      const e = new SkillsEngine({ topN: 3, projectRoot: tmpDir });
      expect(e.topN).toBe(3);
    });

    it('custom skillsDir can be passed', () => {
      const d = join(tmpDir, 'custom-skills');
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'index.json'), '[]', 'utf-8');
      const e = new SkillsEngine({ skillsDir: d, projectRoot: tmpDir });
      expect(e.loadIndex()).toEqual([]);
    });

    it('default projectRoot = process.cwd() when not passed', () => {
      const e = new SkillsEngine();
      expect(e).toBeInstanceOf(SkillsEngine);
      expect(e.topN).toBe(5);
    });
  });

  // ═══════════════ loadIndex() ═══════════════

  describe('loadIndex()', () => {
    it('returns [] when index.json missing', () => {
      expect(engine.loadIndex()).toEqual([]);
    });

    it('parses valid index', () => {
      const e = makeEntry({ name: 'py', file: 'py.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([e]), 'utf-8');
      const ix = engine.loadIndex();
      expect(ix).toHaveLength(1);
      expect(ix[0].name).toBe('py');
      expect(ix[0].file).toBe('py.md');
      expect(ix[0].target_agents).toEqual(['executor']);
      expect(ix[0].triggers).toEqual([{ type: 'keyword', pattern: 'test' }]);
      expect(ix[0].updated_at).toBe('2025-01-15T10:00:00Z');
    });

    it('parses multiple entries', () => {
      const entries = [
        makeEntry({ name: 'a', file: 'a.md', updated_at: '2025-01-01T00:00:00Z' }),
        makeEntry({ name: 'b', file: 'b.md', updated_at: '2025-02-01T00:00:00Z' }),
      ];
      writeFileSync(join(skillsDir, 'index.json'), indexJson(entries), 'utf-8');
      expect(engine.loadIndex().map((x) => x.name)).toEqual(['a', 'b']);
    });

    it('throws for invalid JSON', () => {
      writeFileSync(join(skillsDir, 'index.json'), 'bad {', 'utf-8');
      expect(() => engine.loadIndex()).toThrow(/Failed to parse skill index/);
    });

    it('throws ZodError for missing required fields', () => {
      writeFileSync(join(skillsDir, 'index.json'),
        JSON.stringify([{ file: 'x.md', target_agents: ['executor'] as AgentRole[], triggers: [],
          updated_at: '2025-01-01T00:00:00Z' }]), 'utf-8');
      expect(() => engine.loadIndex()).toThrow();
    });

    it('throws ZodError for invalid trigger type', () => {
      writeFileSync(join(skillsDir, 'index.json'),
        JSON.stringify([{ name: 'x', file: 'x.md', target_agents: ['executor'] as AgentRole[],
          triggers: [{ type: 'bad', pattern: 'x' }],
          updated_at: '2025-01-01T00:00:00Z' }]), 'utf-8');
      expect(() => engine.loadIndex()).toThrow();
    });

    it('throws ZodError for invalid target_agents role', () => {
      writeFileSync(join(skillsDir, 'index.json'),
        JSON.stringify([{ name: 'x', file: 'x.md', target_agents: ['nope'],
          triggers: [{ type: 'keyword', pattern: 'x' }],
          updated_at: '2025-01-01T00:00:00Z' }]), 'utf-8');
      expect(() => engine.loadIndex()).toThrow();
    });

    it('throws ZodError when root is not an array', () => {
      writeFileSync(join(skillsDir, 'index.json'), JSON.stringify({ x: 1 }), 'utf-8');
      expect(() => engine.loadIndex()).toThrow();
    });

    it('caches result (same reference on second call)', () => {
      writeFileSync(join(skillsDir, 'index.json'), indexJson([makeEntry({ name: 'cached' })]), 'utf-8');
      const first = engine.loadIndex();
      writeFileSync(join(skillsDir, 'index.json'), indexJson([makeEntry({ name: 'different' })]), 'utf-8');
      expect(engine.loadIndex()).toBe(first);
    });
  });

  // ═══════════════ getSkillFile() ═══════════════

  describe('getSkillFile()', () => {
    beforeEach(() => {
      writeFileSync(join(skillsDir, 'index.json'),
        indexJson([makeEntry({ name: 's', file: 's.md' })]), 'utf-8');
      writeFileSync(join(skillsDir, 's.md'), '# Hello\nWorld', 'utf-8');
    });

    it('returns file content', async () => {
      expect(await engine.getSkillFile('s')).toBe('# Hello\nWorld');
    });

    it('throws for unknown name', async () => {
      await expect(engine.getSkillFile('nope')).rejects.toThrow(
        /Skill "nope" not found in index/);
    });

    it('throws when file missing on disk', async () => {
      writeFileSync(join(skillsDir, 'index.json'),
        indexJson([makeEntry({ name: 'ghost', file: 'ghost.md' })]), 'utf-8');
      await expect(engine.getSkillFile('ghost')).rejects.toThrow(
        /Skill file not found/);
    });

    it('caches content within TTL', async () => {
      const first = await engine.getSkillFile('s');
      writeFileSync(join(skillsDir, 's.md'), '# Changed', 'utf-8');
      expect(await engine.getSkillFile('s')).toBe(first);
    });

    it('separate instances do not share cache', async () => {
      const e1 = new SkillsEngine({ projectRoot: tmpDir });
      const e2 = new SkillsEngine({ projectRoot: tmpDir });
      expect(await e1.getSkillFile('s')).toBe('# Hello\nWorld');
      expect(await e2.getSkillFile('s')).toBe('# Hello\nWorld');
    });
  });

  // ═══════════════ matchSkills() — Role Filtering ═══════════════

  describe('matchSkills() — Role Filtering', () => {
    beforeEach(() => {
      const entries = [
        makeEntry({ name: 'exec', target_agents: ['executor'] as AgentRole[],
          triggers: [{ type: 'keyword', pattern: 'x' }] }),
        makeEntry({ name: 'plan', target_agents: ['planner'],
          triggers: [{ type: 'keyword', pattern: 'x' }] }),
        makeEntry({ name: 'both', target_agents: ['executor', 'planner'],
          triggers: [{ type: 'keyword', pattern: 'x' }] }),
      ];
      writeFileSync(join(skillsDir, 'index.json'), indexJson(entries), 'utf-8');
      for (const e of entries) writeFileSync(join(skillsDir, e.file), `# ${e.name}\n`, 'utf-8');
    });

    it('only skills targeting current role considered', async () => {
      const m = await engine.matchSkills(mkParams({ goalDescription: 'x', targetRole: 'planner' }));
      expect(m.map((s) => s.name).sort()).toEqual(['both', 'plan']);
    });

    it('skills targeting other roles excluded', async () => {
      const m = await engine.matchSkills(mkParams({ goalDescription: 'x', targetRole: 'executor' }));
      const names = m.map((s) => s.name);
      expect(names).toContain('exec');
      expect(names).toContain('both');
      expect(names).not.toContain('plan');
    });
  });

  // ═══════════════ matchSkills() — Keyword ═══════════════

  describe('matchSkills() — Keyword Trigger', () => {
    beforeEach(() => {
      const e = makeEntry({ name: 'py', file: 'py.md',
        triggers: [{ type: 'keyword', pattern: 'python' }] });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([e]), 'utf-8');
      writeFileSync(join(skillsDir, 'py.md'), '# py\n', 'utf-8');
    });

    it('matches goalDescription (case-insensitive)', async () => {
      const m = await engine.matchSkills(
        mkParams({ goalDescription: 'Build Python API', cardDescription: '' }));
      expect(m).toHaveLength(1);
      expect(m[0].name).toBe('py');
    });

    it('matches cardDescription (case-insensitive)', async () => {
      const m = await engine.matchSkills(
        mkParams({ goalDescription: '', cardDescription: 'uses python' }));
      expect(m).toHaveLength(1);
    });

    it('case-insensitive', async () => {
      const m = await engine.matchSkills(mkParams({ goalDescription: 'PYTHON stuff' }));
      expect(m).toHaveLength(1);
    });

    it('does not match absent pattern', async () => {
      const m = await engine.matchSkills(mkParams({ goalDescription: 'Rust stuff' }));
      expect(m).toHaveLength(0);
    });
  });

  // ═══════════════ matchSkills() — Tool ═══════════════

  describe('matchSkills() — Tool Trigger', () => {
    beforeEach(() => {
      const e = makeEntry({ name: 'git-s', file: 'git-s.md',
        triggers: [{ type: 'tool', pattern: 'git' }] });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([e]), 'utf-8');
      writeFileSync(join(skillsDir, 'git-s.md'), '# git\n', 'utf-8');
    });

    it('matches exact tool in availableTools', async () => {
      const m = await engine.matchSkills(mkParams({ availableTools: ['git', 'npm'] }));
      expect(m).toHaveLength(1);
      expect(m[0].name).toBe('git-s');
    });

    it('does not match absent tool', async () => {
      const m = await engine.matchSkills(mkParams({ availableTools: ['docker'] }));
      expect(m).toHaveLength(0);
    });

    it('case-sensitive', async () => {
      const m = await engine.matchSkills(mkParams({ availableTools: ['GIT'] }));
      expect(m).toHaveLength(0);
    });
  });

  // ═══════════════ matchSkills() — Path ═══════════════

  describe('matchSkills() — Path Trigger', () => {
    beforeEach(() => {
      const e = makeEntry({ name: 'py-conv', file: 'py-conv.md',
        triggers: [{ type: 'path', pattern: '**/*.py' }] });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([e]), 'utf-8');
      writeFileSync(join(skillsDir, 'py-conv.md'), '# py\n', 'utf-8');
    });

    it('matches glob', async () => {
      const m = await engine.matchSkills(mkParams({ filePaths: ['src/main.py'] }));
      expect(m).toHaveLength(1);
      expect(m[0].name).toBe('py-conv');
    });

    it('matches nested paths with **', async () => {
      const m = await engine.matchSkills(mkParams({ filePaths: ['a/b/c/file.py'] }));
      expect(m).toHaveLength(1);
    });

    it('does not match wrong extension', async () => {
      const m = await engine.matchSkills(mkParams({ filePaths: ['src/main.ts'] }));
      expect(m).toHaveLength(0);
    });

    it('* matches single segment', async () => {
      const e2 = makeEntry({ name: 'cfg', file: 'cfg.md',
        triggers: [{ type: 'path', pattern: '*.json' }] });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([e2]), 'utf-8');
      writeFileSync(join(skillsDir, 'cfg.md'), '# cfg\n', 'utf-8');
      const eng = new SkillsEngine({ projectRoot: tmpDir });
      const m = await eng.matchSkills(mkParams({ filePaths: ['package.json'] }));
      expect(m).toHaveLength(1);
      expect(m[0].name).toBe('cfg');
    });

    it('* does not cross segments', async () => {
      const eng = new SkillsEngine({ projectRoot: tmpDir });
      const m = await eng.matchSkills(mkParams({ filePaths: ['src/package.json'] }));
      expect(m).toHaveLength(0);
    });

    it('? matches single char', async () => {
      const e2 = makeEntry({ name: 'test-s', file: 'test-s.md',
        triggers: [{ type: 'path', pattern: '**/*.test.?s' }] });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([e2]), 'utf-8');
      writeFileSync(join(skillsDir, 'test-s.md'), '# ts\n', 'utf-8');
      const eng = new SkillsEngine({ projectRoot: tmpDir });
      const m = await eng.matchSkills(mkParams({ filePaths: ['src/foo.test.ts'] }));
      expect(m).toHaveLength(1);
    });
  });

  // ═══════════════ matchSkills() — Tag ═══════════════

  describe('matchSkills() — Tag Trigger', () => {
    beforeEach(() => {
      const e = makeEntry({ name: 'dp', file: 'dp.md',
        triggers: [{ type: 'tag', pattern: 'data-pipeline' }] });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([e]), 'utf-8');
      writeFileSync(join(skillsDir, 'dp.md'), '# dp\n', 'utf-8');
    });

    it('matches when pattern in tags', async () => {
      const m = await engine.matchSkills(mkParams({ tags: ['data-pipeline', 'ETL'] }));
      expect(m).toHaveLength(1);
      expect(m[0].name).toBe('dp');
    });

    it('does not match absent tag', async () => {
      const m = await engine.matchSkills(mkParams({ tags: ['web'] }));
      expect(m).toHaveLength(0);
    });

    it('case-sensitive', async () => {
      const m = await engine.matchSkills(mkParams({ tags: ['Data-Pipeline'] }));
      expect(m).toHaveLength(0);
    });
  });

  // ═══════════════ matchSkills() — Scoring ═══════════════

  describe('matchSkills() — Scoring', () => {
    beforeEach(() => {
      const entries: SkillIndexEntry[] = [
        { name: 'one', file: 'one.md', target_agents: ['executor'] as AgentRole[],
          triggers: [{ type: 'keyword', pattern: 'test' }],
          updated_at: '2025-01-01T00:00:00Z' },
        { name: 'two', file: 'two.md', target_agents: ['executor'] as AgentRole[],
          triggers: [{ type: 'keyword', pattern: 'test' }, { type: 'tag', pattern: 'testing' }],
          updated_at: '2025-01-01T00:00:00Z' },
        { name: 'zero', file: 'zero.md', target_agents: ['executor'] as AgentRole[],
          triggers: [{ type: 'keyword', pattern: 'nope' }],
          updated_at: '2025-01-01T00:00:00Z' },
      ];
      writeFileSync(join(skillsDir, 'index.json'), indexJson(entries), 'utf-8');
      for (const e of entries) writeFileSync(join(skillsDir, e.file), `# ${e.name}\n`, 'utf-8');
    });

    it('each matching trigger adds 1 to score', async () => {
      const m = await engine.matchSkills(
        mkParams({ goalDescription: 'test framework', tags: ['testing'] }));
      expect(m[0].name).toBe('two');
      expect(m[1].name).toBe('one');
    });

    it('2 triggers > 1 trigger', async () => {
      const m = await engine.matchSkills(
        mkParams({ goalDescription: 'test framework', tags: ['testing'] }));
      expect(m[0].name).toBe('two');
      expect(m[1].name).toBe('one');
    });

    it('score 0 skills excluded', async () => {
      const m = await engine.matchSkills(
        mkParams({ goalDescription: 'test framework', tags: ['testing'] }));
      expect(m.map((s) => s.name)).not.toContain('zero');
    });
  });

  // ═══════════════ matchSkills() — Ranking ═══════════════

  describe('matchSkills() — Ranking', () => {
    beforeEach(() => {
      const entries: SkillIndexEntry[] = [
        { name: 'newer', file: 'n.md', target_agents: ['executor'] as AgentRole[],
          triggers: [{ type: 'keyword', pattern: 'test' }],
          updated_at: '2025-03-01T00:00:00Z' },
        { name: 'older', file: 'o.md', target_agents: ['executor'] as AgentRole[],
          triggers: [{ type: 'keyword', pattern: 'test' }],
          updated_at: '2025-01-01T00:00:00Z' },
        { name: 'high', file: 'hi.md', target_agents: ['executor'] as AgentRole[],
          triggers: [{ type: 'keyword', pattern: 'test' }, { type: 'keyword', pattern: 'framework' }],
          updated_at: '2025-01-01T00:00:00Z' },
      ];
      writeFileSync(join(skillsDir, 'index.json'), indexJson(entries), 'utf-8');
      for (const e of entries) writeFileSync(join(skillsDir, e.file), `# ${e.name}\n`, 'utf-8');
    });

    it('sorted by score desc', async () => {
      const m = await engine.matchSkills(mkParams({ goalDescription: 'test framework' }));
      expect(m[0].name).toBe('high');
    });

    it('tied scores: newer updated_at first', async () => {
      // goalDescription='test' matches 'newer' and 'older' on keyword 'test'.
      // 'high' matches 'test' but NOT 'framework', so all three score=1.
      // Tied on score, sorted by updated_at desc → newer first.
      const m = await engine.matchSkills(mkParams({ goalDescription: 'test' }));
      expect(m).toHaveLength(3);
      expect(m[0].name).toBe('newer'); // 2025-03 > 2025-01
    });
  });

  // ═══════════════ matchSkills() — Top N ═══════════════

  describe('matchSkills() — Top N', () => {
    beforeEach(() => {
      const entries = Array.from({ length: 10 }, (_, i) => ({
        name: `s${i}`, file: `s${i}.md`,
        target_agents: ['executor'] as AgentRole[],
        triggers: [{ type: 'keyword' as const, pattern: 'test' }],
        updated_at: new Date(2025, 0, 10 - i).toISOString(),
      }));
      writeFileSync(join(skillsDir, 'index.json'), indexJson(entries), 'utf-8');
      for (const e of entries) writeFileSync(join(skillsDir, e.file), `# ${e.name}\n`, 'utf-8');
    });

    it('default topN=5 returns at most 5', async () => {
      const m = await engine.matchSkills(mkParams({ goalDescription: 'test framework' }));
      expect(m).toHaveLength(5);
    });

    it('custom topN=2 returns at most 2', async () => {
      const e2 = new SkillsEngine({ topN: 2, projectRoot: tmpDir });
      const m = await e2.matchSkills(mkParams({ goalDescription: 'test framework' }));
      expect(m).toHaveLength(2);
    });

    it('returns all when fewer match than topN', async () => {
      const few: SkillIndexEntry[] = [
        makeEntry({ name: 'a', file: 'a.md',
          triggers: [{ type: 'keyword', pattern: 'rare' }],
          updated_at: '2025-01-01T00:00:00Z' }),
        makeEntry({ name: 'b', file: 'b.md',
          triggers: [{ type: 'keyword', pattern: 'rare' }],
          updated_at: '2025-01-02T00:00:00Z' }),
      ];
      writeFileSync(join(skillsDir, 'index.json'), indexJson(few), 'utf-8');
      for (const e of few) writeFileSync(join(skillsDir, e.file), `# ${e.name}\n`, 'utf-8');
      const e2 = new SkillsEngine({ topN: 5, projectRoot: tmpDir });
      const m = await e2.matchSkills(mkParams({ goalDescription: 'rare' }));
      expect(m).toHaveLength(2);
    });
  });

  // ═══════════════ formatSkills() ═══════════════

  describe('formatSkills()', () => {
    it('returns empty string for empty array', async () => {
      expect(await engine.formatSkills([])).toBe('');
    });

    it('formats single skill with delimiters', async () => {
      const e = makeEntry({ name: 'py', file: 'py.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([e]), 'utf-8');
      writeFileSync(join(skillsDir, 'py.md'), '# 4 spaces\nsnake_case', 'utf-8');
      const result = await engine.formatSkills([e]);
      expect(result).toBe('--- SKILL: py ---\n# 4 spaces\nsnake_case\n--- END SKILL ---');
    });

    it('formats multiple skills with double newlines', async () => {
      const entries = [
        makeEntry({ name: 'a', file: 'a.md' }),
        makeEntry({ name: 'b', file: 'b.md' }),
      ];
      writeFileSync(join(skillsDir, 'index.json'), indexJson(entries), 'utf-8');
      writeFileSync(join(skillsDir, 'a.md'), 'CA', 'utf-8');
      writeFileSync(join(skillsDir, 'b.md'), 'CB', 'utf-8');
      const result = await engine.formatSkills(entries);
      expect(result).toBe(
        '--- SKILL: a ---\nCA\n--- END SKILL ---\n\n--- SKILL: b ---\nCB\n--- END SKILL ---');
    });

    it('includes file content between delimiters', async () => {
      const e = makeEntry({ name: 's', file: 's.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([e]), 'utf-8');
      writeFileSync(join(skillsDir, 's.md'), '# T\n\n## S\nStuff.', 'utf-8');
      const result = await engine.formatSkills([e]);
      expect(result).toContain('--- SKILL: s ---');
      expect(result).toContain('# T');
      expect(result).toContain('## S');
      expect(result).toContain('Stuff.');
      expect(result).toContain('--- END SKILL ---');
    });
  });

  // ═══════════════ selectAndFormat() ═══════════════

  describe('selectAndFormat()', () => {
    it('returns empty string when no skills match', async () => {
      const e = makeEntry({ name: 'py', file: 'py.md',
        triggers: [{ type: 'keyword', pattern: 'python' }] });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([e]), 'utf-8');
      writeFileSync(join(skillsDir, 'py.md'), '# py\n', 'utf-8');
      const result = await engine.selectAndFormat(mkParams({ goalDescription: 'Rust' }));
      expect(result).toBe('');
    });

    it('returns formatted skills when matches exist', async () => {
      const e = makeEntry({ name: 'py', file: 'py.md',
        triggers: [{ type: 'keyword', pattern: 'python' }] });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([e]), 'utf-8');
      writeFileSync(join(skillsDir, 'py.md'), '# Use 4 spaces', 'utf-8');
      const result = await engine.selectAndFormat(
        mkParams({ goalDescription: 'Build a Python API' }));
      expect(result).toContain('--- SKILL: py ---');
      expect(result).toContain('# Use 4 spaces');
      expect(result).toContain('--- END SKILL ---');
    });
  });

  // ═══════════════ loadPlannerInstructions() ═══════════════

  describe('loadPlannerInstructions()', () => {
    it('returns formatted content when planner.md exists', async () => {
      const instrDir = join(tmpDir, '.saivage', 'instructions');
      mkdirSync(instrDir, { recursive: true });
      writeFileSync(join(instrDir, 'planner.md'),
        '# Planner\nStrategy: be incremental', 'utf-8');
      const result = await engine.loadPlannerInstructions();
      expect(result).toContain('--- PLANNER INSTRUCTIONS ---');
      expect(result).toContain('# Planner');
      expect(result).toContain('Strategy: be incremental');
      expect(result).toContain('--- END PLANNER INSTRUCTIONS ---');
    });

    it("returns '' when file does not exist", async () => {
      expect(await engine.loadPlannerInstructions()).toBe('');
    });

    it("returns '' for empty file", async () => {
      const instrDir = join(tmpDir, '.saivage', 'instructions');
      mkdirSync(instrDir, { recursive: true });
      writeFileSync(join(instrDir, 'planner.md'), '   \n  ', 'utf-8');
      expect(await engine.loadPlannerInstructions()).toBe('');
    });
  });

  // ═══════════════ loadPlannerInstructions() — custom path ═══════

  describe('loadPlannerInstructions() — custom path', () => {
    it('loads custom path when customFilePath provided', async () => {
      const instrDir = join(tmpDir, 'my-goal-instructions');
      mkdirSync(instrDir, { recursive: true });
      writeFileSync(join(instrDir, 'custom.md'),
        '# Custom\nDo things differently', 'utf-8');
      const result = await engine.loadPlannerInstructions('my-goal-instructions/custom.md');
      expect(result).toContain('--- PLANNER INSTRUCTIONS ---');
      expect(result).toContain('# Custom');
      expect(result).toContain('Do things differently');
      expect(result).toContain('--- END PLANNER INSTRUCTIONS ---');
    });

    it("returns '' when custom path does not exist", async () => {
      const result = await engine.loadPlannerInstructions('nonexistent/path.md');
      expect(result).toBe('');
    });

    it("returns '' for empty custom file", async () => {
      const instrDir = join(tmpDir, 'empty');
      mkdirSync(instrDir, { recursive: true });
      writeFileSync(join(instrDir, 'empty.md'), '   \n  ', 'utf-8');
      expect(await engine.loadPlannerInstructions('empty/empty.md')).toBe('');
    });

    it('default path still works when customFilePath omitted', async () => {
      const instrDir = join(tmpDir, '.saivage', 'instructions');
      mkdirSync(instrDir, { recursive: true });
      writeFileSync(join(instrDir, 'planner.md'),
        '# Default\nDefault strategy', 'utf-8');
      const result = await engine.loadPlannerInstructions();
      expect(result).toContain('--- PLANNER INSTRUCTIONS ---');
      expect(result).toContain('# Default');
      expect(result).toContain('Default strategy');
    });

    it('custom path does not populate default cache', async () => {
      // Load a custom path first
      const d1 = join(tmpDir, 'c1');
      mkdirSync(d1, { recursive: true });
      writeFileSync(join(d1, 'a.md'), 'Custom A', 'utf-8');
      await engine.loadPlannerInstructions('c1/a.md');

      // Default path should still be '' since planner.md doesn't exist
      expect(await engine.loadPlannerInstructions()).toBe('');
    });
  });

  // ═══════════════ System Prompt Integration ═══════════════

  describe('System Prompt Integration', () => {
    const plannerContract = createPlannerContract({ goalId: 'g', parentSessionId: 'planner:g' });
    const executorContract = createExecutorContract({ cardId: 'c', goalId: 'g' });
    const reviewerContract = createReviewerContract({ goalId: 'g', assessmentId: 'a' });

    it('buildPlannerPrompt(skills) appends skills when provided', () => {
      const prompt = buildPlannerPrompt(plannerContract, '--- SKILL: test ---\ncontent\n--- END SKILL ---');
      expect(prompt).toContain('--- SKILL: test ---');
      expect(prompt).toContain('--- END SKILL ---');
    });

    it('buildExecutorPrompt(cardType, skills) appends skills', () => {
      const prompt = buildExecutorPrompt(executorContract, 'code',
        '--- SKILL: test ---\ncontent\n--- END SKILL ---');
      expect(prompt).toContain('--- SKILL: test ---');
      expect(prompt).toContain('--- END SKILL ---');
      expect(prompt).toContain('Executor');
    });

    it('buildReviewerPrompt(skills) appends skills', () => {
      const prompt = buildReviewerPrompt(reviewerContract,
        '--- SKILL: test ---\ncontent\n--- END SKILL ---');
      expect(prompt).toContain('--- SKILL: test ---');
      expect(prompt).toContain('--- END SKILL ---');
      expect(prompt).toContain('Reviewer');
    });

    it('buildPlannerPrompt() without skills returns base prompt', () => {
      const prompt = buildPlannerPrompt(plannerContract);
      expect(prompt).toContain('Planner');
      expect(prompt).not.toContain('--- SKILL:');
    });

    it('buildExecutorPrompt(cardType) without skills returns base prompt', () => {
      const prompt = buildExecutorPrompt(executorContract, 'code');
      expect(prompt).toContain('Executor');
      expect(prompt).not.toContain('--- SKILL:');
    });

    it('buildReviewerPrompt() without skills returns base prompt', () => {
      const prompt = buildReviewerPrompt(reviewerContract);
      expect(prompt).toContain('Reviewer');
      expect(prompt).not.toContain('--- SKILL:');
    });

    it('skills are appended after double newline', () => {
      const base = buildPlannerPrompt(plannerContract);
      const withSkills = buildPlannerPrompt(plannerContract, '--- SKILL: x ---\n\n--- END SKILL ---');
      expect(withSkills).toBe(base + '\n\n--- SKILL: x ---\n\n--- END SKILL ---');
    });

    it('empty skills string is not appended (guard)', () => {
      const base = buildPlannerPrompt(plannerContract);
      expect(buildPlannerPrompt(plannerContract, '')).toBe(base);
    });
  });
});
