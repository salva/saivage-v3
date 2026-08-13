import { describe, expect, it } from '@jest/globals';

import { cardDepth, cardIdSchema, childCardId, MAX_CARD_DEPTH, nextCardSegment } from '../../src/schemas/card-id.js';

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

  it('accepts one to twelve alphabetic hierarchy segments only', () => {
    const twelve = `card-${Array.from({ length: MAX_CARD_DEPTH }, () => 'a').join('-')}`;
    const thirteen = `${twelve}-a`;
    expect(cardIdSchema.parse('project')).toBe('project');
    expect(cardDepth('project')).toBe(0);
    expect(cardIdSchema.parse('card-a')).toBe('card-a');
    expect(cardIdSchema.parse(twelve)).toBe(twelve);
    expect(cardDepth(twelve)).toBe(MAX_CARD_DEPTH);
    expect(() => cardIdSchema.parse(thirteen)).toThrow('Expected a hierarchical card id with one to 12 alphabetic segments.');
    expect(() => cardIdSchema.parse('card-a-1')).toThrow();
    expect(() => cardIdSchema.parse('card-A')).toThrow();
    expect(() => cardIdSchema.parse('card-a-')).toThrow();
  });

  it('creates the twelfth segment and rejects a thirteenth', () => {
    let id = 'project';
    for (let depth = 1; depth <= MAX_CARD_DEPTH; depth += 1) id = childCardId(id, 'a');
    expect(cardDepth(id)).toBe(MAX_CARD_DEPTH);
    expect(() => childCardId(id, 'a')).toThrow('Expected a hierarchical card id with one to 12 alphabetic segments.');
  });
});
