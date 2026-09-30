import { describe, expect, it } from '@jest/globals';

import { uuidV4Schema } from '../../src/schemas/index.js';
import { versionFilename } from '../../src/persistence/version-index.js';

describe('canonical UUID-v4 schema', () => {
  it('accepts lowercase v4 IDs and rejects other versions, variants, and case', () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    expect(uuidV4Schema.parse(id)).toBe(id);
    expect(versionFilename(1, id, 'jsonl')).toBe(`1-${id}.jsonl`);
    for (const invalid of [
      '123e4567-e89b-12d3-a456-426614174000',
      '123e4567-e89b-42d3-7456-426614174000',
      '123e4567-e89b-42d3-A456-426614174000',
      '123E4567-e89b-42d3-a456-426614174000',
    ]) {
      expect(uuidV4Schema.safeParse(invalid).success).toBe(false);
      expect(() => versionFilename(1, invalid, 'jsonl')).toThrow();
    }
  });
});
