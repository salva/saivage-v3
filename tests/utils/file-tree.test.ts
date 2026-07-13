import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initProjectTree } from '../helpers/canonical-project.js';
import { isInitialized } from '../../src/persistence/file-tree.js';

describe('current project initialization', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'saivage-file-tree-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('requires canonical root plus current defaults', () => {
    expect(isInitialized(root)).toBe(false);
    initProjectTree(root);
    expect(isInitialized(root)).toBe(true);
    expect(existsSync(join(root, '.saivage', 'cards', 'project', 'card', 'versions', '1.json'))).toBe(true);
    expect(existsSync(join(root, '.saivage', 'cards', 'index.json'))).toBe(false);
  });
});
