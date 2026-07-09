import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initProjectTree } from '../../src/persistence/file-tree.js';

const priorWorkRoot = `.saivage-${'work'}`;

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

  it('discards prior card metadata and external work roots before creating the current layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-file-tree-'));
    try {
      mkdirSync(join(root, '.saivage', 'outputs', 'cards', 'card-1'), { recursive: true });
      mkdirSync(join(root, priorWorkRoot, 'processes', 'proc-1'), { recursive: true });

      initProjectTree(root);

      expect(existsSync(join(root, '.saivage', 'cards'))).toBe(true);
      expect(existsSync(join(root, '.saivage', 'work', 'processes'))).toBe(true);
      expect(existsSync(join(root, '.saivage', 'outputs', 'cards'))).toBe(false);
      expect(existsSync(join(root, priorWorkRoot))).toBe(false);
      expect(readdirSync(root).some((entry) => entry.startsWith('.saivage.discarded-'))).toBe(true);
      expect(readdirSync(root).some((entry) => entry.startsWith(`${priorWorkRoot}.discarded-`))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recreates disposable work directories for current durable state', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-file-tree-'));
    try {
      initProjectTree(root);
      rmSync(join(root, '.saivage', 'work'), { recursive: true, force: true });

      initProjectTree(root);

      expect(existsSync(join(root, '.saivage', 'project.json'))).toBe(true);
      expect(existsSync(join(root, '.saivage', 'cards'))).toBe(true);
      expect(existsSync(join(root, '.saivage', 'work', 'tmp', 'runtime'))).toBe(true);
      expect(existsSync(join(root, priorWorkRoot))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
