import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { run } from '../../src/cli.js';

describe('saivage reset', () => {
  it('clears cards runtime and notes while preserving auth and project files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-reset-'));
    const cwd = process.cwd();
    try {
      initProjectTree(root);
      mkdirSync(join(root, '.saivage', 'notes', 'by-card', 'x'), { recursive: true });
      writeFileSync(join(root, '.saivage', 'runtime', 'state.json'), '{}');
      writeFileSync(join(root, '.saivage', 'auth-profiles.json'), '{"keep":true}');
      writeFileSync(join(root, '.saivage', 'project.json'), '{"keep":true}');
      process.chdir(root);
      await run(['node', 'cli', 'reset']);
      expect(existsSync(join(root, '.saivage', 'cards'))).toBe(false);
      expect(existsSync(join(root, '.saivage', 'runtime'))).toBe(false);
      expect(existsSync(join(root, '.saivage', 'notes'))).toBe(false);
      expect(existsSync(join(root, '.saivage', 'auth-profiles.json'))).toBe(true);
      expect(existsSync(join(root, '.saivage', 'project.json'))).toBe(true);
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
