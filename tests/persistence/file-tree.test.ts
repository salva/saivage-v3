import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initProjectTree } from '../helpers/canonical-project.js';

describe('canonical initialization boundary', () => {
  it('initializes a fresh project and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-file-tree-'));
    try { expect(initProjectTree(root)).toEqual({ projectRoot: root }); expect(initProjectTree(root)).toEqual({ projectRoot: root }); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a missing root in a nonfresh generated layout without discarding evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-file-tree-'));
    try {
      mkdirSync(join(root, '.saivage', 'agents'), { recursive: true });
      const evidence = join(root, '.saivage', 'agents', 'evidence.json'); writeFileSync(evidence, '{}');
      expect(() => initProjectTree(root)).toThrow(/Cannot enumerate canonical project/);
      expect(readFileSync(evidence, 'utf8')).toBe('{}');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
