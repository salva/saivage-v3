import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSyncIdempotentByKey, PersistenceReadError } from '../../src/persistence/index.js';

describe('appendSyncIdempotentByKey', () => {
  it('is idempotent across the complete append file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'saivage-raw-jsonl-')), 'rows.jsonl');
    expect(appendSyncIdempotentByKey(path, { id: 'A' }, 'id')).toBe(true);
    expect(appendSyncIdempotentByKey(path, { id: 'B' }, 'id')).toBe(true);
    expect(appendSyncIdempotentByKey(path, { id: 'A' }, 'id')).toBe(false);
    expect(readFileSync(path, 'utf-8').split('\n').filter(Boolean)).toHaveLength(2);
  });

  it.each(['{"id":"A"}\nnot-json\n', '{"id":"A"}'])('fails without changing malformed input %p', (content) => {
    const path = join(mkdtempSync(join(tmpdir(), 'saivage-raw-jsonl-')), 'rows.jsonl');
    writeFileSync(path, content);
    expect(() => appendSyncIdempotentByKey(path, { id: 'B' }, 'id')).toThrow(PersistenceReadError);
    expect(readFileSync(path, 'utf-8')).toBe(content);
  });
});
