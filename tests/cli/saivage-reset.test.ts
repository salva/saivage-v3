import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { run } from '../../src/cli.js';

describe('saivage reset', () => {
  it('clears cards runtime and notes while preserving auth, project, and objective files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-reset-'));
    const cwd = process.cwd();
    const objectivePath = join(root, 'research', 'future-objectives', 'analyst-system-control-objectives.md');
    const designPath = join(root, 'research', 'future-objectives', 'analyst-system-control-design.md');
    const planPath = join(root, 'research', 'future-objectives', 'analyst-system-control-implementation-plan.md');
    const objectiveContent = '# objectives\nkeep me\n';
    const designContent = '# design\nkeep me\n';
    const planContent = '# implementation plan\nkeep me\n';
    try {
      initProjectTree(root);
      mkdirSync(join(root, '.saivage', 'notes', 'by-card', 'x'), { recursive: true });
      mkdirSync(join(root, 'research', 'future-objectives'), { recursive: true });
      writeFileSync(join(root, '.saivage', 'runtime', 'state.json'), '{}');
      writeFileSync(join(root, '.saivage', 'auth-profiles.json'), '{"keep":true}');
      writeFileSync(join(root, '.saivage', 'project.json'), '{"keep":true}');
      writeFileSync(objectivePath, objectiveContent);
      writeFileSync(designPath, designContent);
      writeFileSync(planPath, planContent);
      process.chdir(root);
      await run(['node', 'cli', 'reset']);
      expect(existsSync(join(root, '.saivage', 'cards'))).toBe(false);
      expect(existsSync(join(root, '.saivage', 'runtime'))).toBe(false);
      expect(existsSync(join(root, '.saivage', 'notes'))).toBe(false);
      expect(existsSync(join(root, '.saivage', 'auth-profiles.json'))).toBe(true);
      expect(existsSync(join(root, '.saivage', 'project.json'))).toBe(true);
      expect(existsSync(objectivePath)).toBe(true);
      expect(existsSync(designPath)).toBe(true);
      expect(existsSync(planPath)).toBe(true);
      expect(readFileSync(objectivePath, 'utf8')).toBe(objectiveContent);
      expect(readFileSync(designPath, 'utf8')).toBe(designContent);
      expect(readFileSync(planPath, 'utf8')).toBe(planContent);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses while runtime lockfile is present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-reset-lock-'));
    const cwd = process.cwd();
    try {
      initProjectTree(root);
      mkdirSync(join(root, '.saivage-work', 'tmp', 'runtime'), { recursive: true });
      writeFileSync(join(root, '.saivage-work', 'tmp', 'runtime', 'runtime.lock'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      process.chdir(root);
      await expect(run(['node', 'cli', 'reset'])).rejects.toThrow(/lock/i);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
