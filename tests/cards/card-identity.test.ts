import { describe, expect, it } from '@jest/globals';

import { cardIdSchema, nextCardSegment } from '../../src/schemas/card-id.js';

describe('card identity allocation', () => {
  it('uses spreadsheet-style successors', () => {
    expect(nextCardSegment()).toBe('a');
    expect(nextCardSegment('a')).toBe('b');
    expect(nextCardSegment('z')).toBe('aa');
    expect(nextCardSegment('az')).toBe('ba');
    expect(nextCardSegment('zz')).toBe('aaa');
  });

  it('rejects malformed segments without imposing a legacy length ceiling', () => {
    expect(() => nextCardSegment('A')).toThrow();
    expect(nextCardSegment('z'.repeat(28))).toBe(`a${'a'.repeat(28)}`);
    expect(cardIdSchema.parse(`card-${'a'.repeat(29)}`)).toBe(`card-${'a'.repeat(29)}`);
  });

  it('accepts one to five alphabetic hierarchy segments only', () => {
    expect(cardIdSchema.parse('project')).toBe('project');
    expect(cardIdSchema.parse('card-a-b-c-d-e')).toBe('card-a-b-c-d-e');
    expect(() => cardIdSchema.parse('card-a-b-c-d-e-f')).toThrow();
    expect(() => cardIdSchema.parse('card-a-1')).toThrow();
  });
});
