import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { applyProjectPatch } from '../../src/tools/project-file-tools.js';

describe('applyProjectPatch path admission', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function gitProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'saivage-patch-path-'));
    roots.push(root);
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
    if (initialized.status !== 0) throw new Error(initialized.stderr || 'Failed to initialize test Git repository.');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'v1..v2.md'), 'before\n', 'utf8');
    return root;
  }

  it('applies a text patch to an adjacent-dot filename', async () => {
    const root = gitProject();
    const patch = [
      'diff --git a/docs/v1..v2.md b/docs/v1..v2.md',
      '--- a/docs/v1..v2.md',
      '+++ b/docs/v1..v2.md',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      '',
    ].join('\n');

    await expect(applyProjectPatch({ projectRoot: root }, { patch })).resolves.toEqual({
      changed_files: ['docs/v1..v2.md'],
      applied: true,
    });
    expect(readFileSync(join(root, 'docs', 'v1..v2.md'), 'utf8')).toBe('after\n');
  });

  it.each([
    ['../x', '../x'],
    ['a/../b', 'a/../b'],
  ])('rejects parent path %s before invoking Git apply', async (headerPath, unsafePath) => {
    const root = gitProject();
    const patch = `--- ${headerPath}\n+++ ${headerPath}\n@@ -0,0 +1 @@\n+unsafe\n`;
    await expect(applyProjectPatch({ projectRoot: root }, { patch })).rejects.toThrow(`Unsafe patch path '${unsafePath}'.`);
  });
});
