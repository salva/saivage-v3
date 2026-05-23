import { describe, expect, it } from 'vitest';
import { highlight } from '../utils/highlight';

describe('highlight', () => {
  it('produces hljs spans for json input', () => {
    const out = highlight('{"foo": 1}', 'json');
    expect(out).toContain('hljs-attr');
    expect(out).not.toContain('<script>');
  });

  it('html-escapes input for unknown languages', () => {
    const out = highlight('<script>alert(1)</script>', 'cobol');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&lt;/script&gt;');
  });

  it('html-escapes raw script tags even for known languages', () => {
    const out = highlight('<script>alert(1)</script>', 'json');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;');
  });

  it('returns empty string for empty input without throwing', () => {
    expect(highlight('')).toBe('');
    expect(highlight('', 'json')).toBe('');
  });

  it('falls back to escaped text when language is unsupported', () => {
    const out = highlight('value & co', undefined);
    expect(out).toBe('value &amp; co');
  });
});
