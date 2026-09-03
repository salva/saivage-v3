import { describe, expect, it } from '@jest/globals';
import { ToolResultSchema, toolFailed, toolSucceeded } from '../../src/contracts/tool-result.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { canonicalJson } from '../../src/schemas/index.js';

describe('ToolResult authority', () => {
  it('parses only the strict wire variants', () => {
    expect(ToolResultSchema.parse({ success: true })).toEqual({ success: true });
    expect(ToolResultSchema.parse({ success: false, error: 'failed' })).toEqual({ success: false, error: 'failed' });
    expect(ToolResultSchema.safeParse({ success: true, error: 'no' }).success).toBe(false);
    expect(ToolResultSchema.safeParse({ success: false, error: '' }).success).toBe(false);
  });

  it('keeps the nominal token private, non-enumerable, and frozen', () => {
    const outcome = toolSucceeded({ value: 1 });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(JSON.stringify(outcome)).toBe('{"kind":"succeeded","data":{"value":1}}');
    expect(Object.getOwnPropertySymbols(outcome)).toHaveLength(1);
  });

  it('omits absent optional fields and freezes failed outcomes without serializing the token', () => {
    const succeeded = toolSucceeded();
    const failed = toolFailed('failed');

    expect(succeeded).toEqual({ kind: 'succeeded' });
    expect(JSON.stringify(succeeded)).toBe('{"kind":"succeeded"}');
    expect(Object.isFrozen(failed)).toBe(true);
    expect(failed).toEqual({ kind: 'failed', error: 'failed' });
    expect(JSON.stringify(failed)).toBe('{"kind":"failed","error":"failed"}');
    expect(Object.getOwnPropertySymbols(failed)).toHaveLength(1);
    expect(settleToolActionOutcome(succeeded).providerResult).toEqual({ success: true });
    expect(settleToolActionOutcome(failed).providerResult).toEqual({ success: false, error: 'failed' });
  });

  it('rejects tokenless forgeries shallowly and preserves opaque data', () => {
    expect(() => settleToolActionOutcome({ kind: 'succeeded', data: { success: false } } as never)).toThrow(/authority constructors/);
    expect(settleToolActionOutcome(toolSucceeded({ nested: { success: false } })).providerResult).toEqual({ success: true, data: { nested: { success: false } } });
  });

  it('returns the exact canonical post-redaction bytes', () => {
    const settled = settleToolActionOutcome(toolFailed('failed', { token: 'sk-a' }));
    expect(settled.settledResultBytes).toBe(canonicalJson(settled.providerResult));
    expect(settled.providerResult).toEqual({ success: false, error: 'failed', data: { token: '[REDACTED]' } });
    expect(Buffer.byteLength(settled.settledResultBytes)).toBeGreaterThan(Buffer.byteLength(canonicalJson({ success: false, error: 'failed', data: { token: 'sk-a' } })));
  });
});
