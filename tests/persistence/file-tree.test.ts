import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initProjectTree } from '../../src/persistence/file-tree.js';

describe('initProjectTree legacy rejection', () => {
  it('rejects legacy runtime process registry files', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-file-tree-'));
    try {
      const runtimeDir = join(root, '.saivage', 'runtime');
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(join(runtimeDir, 'processes.json'), '{"schema_version":1,"records":[]}\n');

      initProjectTree(root);

      expect(existsSync(join(root, '.saivage', 'runtime', 'processes.json'))).toBe(false);
      expect(readdirSync(root).some((entry) => entry.startsWith('.saivage.discarded-'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
