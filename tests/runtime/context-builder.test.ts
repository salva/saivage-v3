import { describe, expect, it } from '@jest/globals';
import { summarizeEvidenceRefsForPlannerContext, summarizeForPlannerContext, truncatePlannerContextString } from '../../src/runtime/context-builder.js';

describe('runtime context builder helpers', () => {
  it('truncates long strings with omitted length metadata', () => {
    const value = 'x'.repeat(505);
    expect(truncatePlannerContextString(value)).toBe(`${'x'.repeat(500)}…[truncated 5 chars]`);
  });

  it('summarizes large arrays and deep objects', () => {
    expect(summarizeForPlannerContext([1, 2, 3, 4, 5, 6])).toEqual({ items: [1, 2, 3, 4, 5], omitted_count: 1 });
    expect(summarizeForPlannerContext({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: { kind: 'object_summary', keys: ['d'], omitted_keys: 0 } } } });
  });

  it('summarizes evidence refs with counts', () => {
    expect(summarizeEvidenceRefsForPlannerContext([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }])).toEqual({
      count: 6,
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
      omitted_count: 1,
    });
  });
});
