import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { readCanonicalGrowingFile } from '../../src/persistence/growing-file.js';

describe('canonical growing-file interrupted suffix handling', () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-growing-file-'));
    path = join(root, 'rows.jsonl');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('truncates only an unterminated final physical suffix', () => {
    const complete = '{"version":1,"type":"rows","rows":[{"id":"one"}]}\n';
    writeFileSync(path, `${complete}{"version":1`);

    expect(readCanonicalGrowingFile(path, z.object({ id: z.string() }).strict())).toEqual([{ id: 'one' }]);
    expect(readFileSync(path, 'utf8')).toBe(complete);
  });

  it('leaves complete malformed data present and fails', () => {
    const malformed = '{"version":1,"type":"rows","rows":[]}\n';
    writeFileSync(path, malformed);

    expect(() => readCanonicalGrowingFile(path, z.object({ id: z.string() }).strict())).toThrow('malformed');
    expect(readFileSync(path, 'utf8')).toBe(malformed);
  });
});
