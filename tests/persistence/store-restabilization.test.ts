import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discardIncompleteJsonlTail } from '../../src/persistence/store-restabilization.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('store restabilization', () => {
  it('discards only bytes after the final complete JSONL row', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-jsonl-tail-'));
    roots.push(root);
    const path = join(root, 'events.jsonl');
    writeFileSync(path, '{"complete":true}\n{"incomplete":');

    discardIncompleteJsonlTail(path);

    expect(readFileSync(path, 'utf8')).toBe('{"complete":true}\n');
  });
});
