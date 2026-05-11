import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsEngine } from '../../src/agents/skills-engine.js';
import {
  loadSkill,
  LoadSkillError,
  PERMITTED_ROLES,
} from '../../src/agents/skill-tools.js';
import type { SkillToolsResult } from '../../src/agents/skill-tools.js';
import type { SkillIndexEntry, AgentRole } from '../../src/schemas/types.js';

// ── Helpers ───────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────

describe('loadSkill', () => {
  let tmpDir: string;
  let skillsDir: string;
  let engine: SkillsEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-skill-tools-test-'));
    skillsDir = join(tmpDir, '.saivage', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    engine = new SkillsEngine({ projectRoot: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ═══════════════ Basic Success ═══════════════

  describe('Basic success', () => {
    it('loads a valid skill for a permitted role (planner)', async () => {
      const entry = makeEntry({ name: 'test-skill', file: 'test-skill.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([entry]), 'utf-8');
      writeFileSync(join(skillsDir, 'test-skill.md'), '# Test Skill\n\nSome content here.', 'utf-8');

      const result: SkillToolsResult = await loadSkill('test-skill', 'planner', engine);

      expect(result.skill_name).toBe('test-skill');
      expect(result.loaded).toBe(true);
      expect(result.skill_content).toContain('--- SKILL: test-skill ---');
      expect(result.skill_content).toContain('--- END SKILL ---');
      expect(result.skill_content).toContain('# Test Skill');
      expect(result.skill_content).toContain('Some content here.');
    });
  });

  // ═══════════════ Invalid Roles ═══════════════

  describe('Invalid roles', () => {
    beforeEach(() => {
      const entry = makeEntry({ name: 'test-skill', file: 'test-skill.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([entry]), 'utf-8');
      writeFileSync(join(skillsDir, 'test-skill.md'), '# Skill', 'utf-8');
    });

    it('rejects analyst role', async () => {
      try {
        await loadSkill('test-skill', 'analyst', engine);
        // Should not reach here
        expect('should have thrown').toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LoadSkillError);
        expect((err as LoadSkillError).message).toContain('not permitted');
        expect((err as LoadSkillError).message).toContain('analyst');
      }
    });

    it('rejects content_supervisor role', async () => {
      try {
        await loadSkill('test-skill', 'content_supervisor', engine);
        expect('should have thrown').toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LoadSkillError);
        expect((err as LoadSkillError).message).toContain('not permitted');
        expect((err as LoadSkillError).message).toContain('content_supervisor');
      }
    });
  });

  // ═══════════════ Unknown Skill Name ═══════════════

  describe('Unknown skill name', () => {
    it('throws LoadSkillError when skill name not in index', async () => {
      const entry = makeEntry({ name: 'known', file: 'known.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([entry]), 'utf-8');
      writeFileSync(join(skillsDir, 'known.md'), '# Known', 'utf-8');

      try {
        await loadSkill('nonexistent', 'planner', engine);
        expect('should have thrown').toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LoadSkillError);
        expect((err as LoadSkillError).message).toContain('not found in index');
        expect((err as LoadSkillError).message).toContain('nonexistent');
      }
    });
  });

  // ═══════════════ Missing Skill File ═══════════════

  describe('Missing skill file', () => {
    it('propagates error when indexed skill file does not exist on disk', async () => {
      // Index references a file that doesn't exist
      const entry = makeEntry({ name: 'ghost', file: 'ghost.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([entry]), 'utf-8');
      // Do NOT write ghost.md

      try {
        await loadSkill('ghost', 'planner', engine);
        expect('should have thrown').toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('Skill file not found');
      }
    });
  });

  // ═══════════════ All Permitted Roles ═══════════════

  describe('All permitted roles', () => {
    beforeEach(() => {
      const entry = makeEntry({ name: 'common', file: 'common.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([entry]), 'utf-8');
      writeFileSync(join(skillsDir, 'common.md'), '# Common Skill', 'utf-8');
    });

    it('planner can load skill', async () => {
      const result = await loadSkill('common', 'planner', engine);
      expect(result.skill_name).toBe('common');
      expect(result.loaded).toBe(true);
    });

    it('executor can load skill', async () => {
      const result = await loadSkill('common', 'executor', engine);
      expect(result.skill_name).toBe('common');
      expect(result.loaded).toBe(true);
    });

    it('reviewer can load skill', async () => {
      const result = await loadSkill('common', 'reviewer', engine);
      expect(result.skill_name).toBe('common');
      expect(result.loaded).toBe(true);
    });

    it('PERMITTED_ROLES contains exactly planner, executor, reviewer', () => {
      expect(PERMITTED_ROLES).toEqual(['planner', 'executor', 'reviewer']);
    });
  });

  // ═══════════════ Empty Index ═══════════════

  describe('Empty index', () => {
    it('throws when index is empty (no skills registered)', async () => {
      writeFileSync(join(skillsDir, 'index.json'), '[]', 'utf-8');

      try {
        await loadSkill('anything', 'planner', engine);
        expect('should have thrown').toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LoadSkillError);
        expect((err as LoadSkillError).message).toContain('not found in index');
      }
    });
  });

  // ═══════════════ Format Matches Pre-loaded ═══════════════

  describe('Format matches pre-loaded skill format', () => {
    it('delimited block format is exactly --- SKILL: name --- / --- END SKILL ---', async () => {
      const entry = makeEntry({ name: 'fmt-test', file: 'fmt-test.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([entry]), 'utf-8');
      writeFileSync(join(skillsDir, 'fmt-test.md'), 'Line 1\nLine 2', 'utf-8');

      const result = await loadSkill('fmt-test', 'planner', engine);

      // The format should be: --- SKILL: name ---\n<content>\n--- END SKILL ---
      const expected = '--- SKILL: fmt-test ---\nLine 1\nLine 2\n--- END SKILL ---';
      expect(result.skill_content).toBe(expected);
    });

    it('format starts with --- SKILL: <name> ---', async () => {
      const entry = makeEntry({ name: 'start', file: 'start.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([entry]), 'utf-8');
      writeFileSync(join(skillsDir, 'start.md'), 'Content', 'utf-8');

      const result = await loadSkill('start', 'planner', engine);
      expect(result.skill_content.startsWith('--- SKILL: start ---\n')).toBe(true);
    });

    it('format ends with --- END SKILL ---', async () => {
      const entry = makeEntry({ name: 'end', file: 'end.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([entry]), 'utf-8');
      writeFileSync(join(skillsDir, 'end.md'), 'Content', 'utf-8');

      const result = await loadSkill('end', 'planner', engine);
      expect(result.skill_content.endsWith('\n--- END SKILL ---')).toBe(true);
    });
  });

  // ═══════════════ Multiple Skills: Picks Correct One ═══════════════

  describe('Multiple skills in index', () => {
    beforeEach(() => {
      const entries: SkillIndexEntry[] = [
        makeEntry({ name: 'alpha', file: 'alpha.md', updated_at: '2025-01-01T00:00:00Z' }),
        makeEntry({ name: 'beta', file: 'beta.md', updated_at: '2025-02-01T00:00:00Z' }),
      ];
      writeFileSync(join(skillsDir, 'index.json'), indexJson(entries), 'utf-8');
      writeFileSync(join(skillsDir, 'alpha.md'), '# Alpha content', 'utf-8');
      writeFileSync(join(skillsDir, 'beta.md'), '# Beta content', 'utf-8');
    });

    it('picks the correct skill by name when multiple exist', async () => {
      const result = await loadSkill('beta', 'planner', engine);

      expect(result.skill_name).toBe('beta');
      expect(result.skill_content).toContain('--- SKILL: beta ---');
      expect(result.skill_content).toContain('# Beta content');
      expect(result.skill_content).not.toContain('alpha');
      expect(result.skill_content).not.toContain('# Alpha content');
    });

    it('can load the first skill instead of the second', async () => {
      const result = await loadSkill('alpha', 'planner', engine);

      expect(result.skill_name).toBe('alpha');
      expect(result.skill_content).toContain('--- SKILL: alpha ---');
      expect(result.skill_content).toContain('# Alpha content');
      expect(result.skill_content).not.toContain('beta');
      expect(result.skill_content).not.toContain('# Beta content');
    });
  });
});
