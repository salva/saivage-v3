import { describe, expect, it } from 'vitest';
import { sanitizeCardHistoryValue } from '../utils/sanitize-card-history';

describe('sanitizeCardHistoryValue', () => {
  it('passes plain objects through unchanged', () => {
    const input = { id: 'abc', count: 3, nested: { ok: true } };
    expect(sanitizeCardHistoryValue(input)).toEqual(input);
  });

  it('redacts values for secret-like keys', () => {
    const out = sanitizeCardHistoryValue({ token: 'whatever', password: 'pw', name: 'ok' }) as Record<string, unknown>;
    expect(out.token).toBe('[redacted]');
    expect(out.password).toBe('[redacted]');
    expect(out.name).toBe('ok');
  });

  it('redacts secret-shaped string values inside non-secret keys', () => {
    const out = sanitizeCardHistoryValue({ note: 'sk-abc123def' }) as Record<string, unknown>;
    expect(out.note).toBe('[redacted]');
  });

  it('recurses into arrays', () => {
    const out = sanitizeCardHistoryValue([{ token: 'x' }, 'sk-abc123']) as unknown[];
    expect(out[0]).toEqual({ token: '[redacted]' });
    expect(out[1]).toBe('[redacted]');
  });

  it('recurses into nested objects', () => {
    const out = sanitizeCardHistoryValue({ outer: { token: 'x', kept: 1 } }) as Record<string, Record<string, unknown>>;
    expect(out.outer.token).toBe('[redacted]');
    expect(out.outer.kept).toBe(1);
  });

  it('leaves non-matching strings alone', () => {
    expect(sanitizeCardHistoryValue('plain text')).toBe('plain text');
  });

  it('leaves primitives alone', () => {
    expect(sanitizeCardHistoryValue(42)).toBe(42);
    expect(sanitizeCardHistoryValue(null)).toBe(null);
    expect(sanitizeCardHistoryValue(true)).toBe(true);
  });

  it('redacts authorization, env, config, provider keys', () => {
    const out = sanitizeCardHistoryValue({
      authorization: 'Bearer x',
      env: { a: 1 },
      config: { b: 2 },
      provider: 'openai',
    }) as Record<string, unknown>;
    expect(out.authorization).toBe('[redacted]');
    expect(out.env).toBe('[redacted]');
    expect(out.config).toBe('[redacted]');
    expect(out.provider).toBe('[redacted]');
  });
});
