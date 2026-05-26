import { describe, expect, it } from 'vitest';
import { tokenizeJson } from '../../utils/json-tokenize';

describe('tokenizeJson', () => {
  it('classifies keys, strings, numbers, literals, whitespace, and punctuation', () => {
    const kinds = tokenizeJson('{"ok": true, "n": 2, "s": "x"}').map((token) => token.kind);
    expect(kinds).toContain('key');
    expect(kinds).toContain('literal');
    expect(kinds).toContain('number');
    expect(kinds).toContain('string');
    expect(kinds).toContain('punctuation');
  });
});
