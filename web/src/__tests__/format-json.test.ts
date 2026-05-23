import { describe, expect, it } from 'vitest';
import { formatJson } from '../utils/format-json';

describe('formatJson', () => {
  it('pretty-prints objects with 2-space indent', () => {
    expect(formatJson({ a: 1, b: [2, 3] })).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it('returns the string "undefined" for undefined values', () => {
    expect(formatJson(undefined)).toBe('undefined');
  });

  it('falls back to String(value) on circular refs', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const out = formatJson(obj);
    expect(out).toBe(String(obj));
    expect(out).toContain('[object Object]');
  });

  it('applies redactor before stringify', () => {
    const redactor = (v: unknown) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const result: Record<string, unknown> = {};
        for (const [k] of Object.entries(v as Record<string, unknown>)) {
          result[k] = '[redacted]';
        }
        return result;
      }
      return v;
    };
    const out = formatJson({ token: 'sk-abc', name: 'ok' }, { redactor });
    expect(out).toContain('"[redacted]"');
    expect(out).not.toContain('sk-abc');
    expect(out).not.toContain('"ok"');
  });

  it('handles plain string values', () => {
    expect(formatJson('hello')).toBe('"hello"');
  });
});
