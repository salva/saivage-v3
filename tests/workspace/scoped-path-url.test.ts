import { describe, expect, it } from '@jest/globals';

import { buildScopedPathUrl, parseScopedPathUrl } from '../../src/contracts/scoped-path-url.js';

describe('scoped path URL helper', () => {
  it('round-trips canonical triple-slash scoped path URLs', () => {
    const raw = buildScopedPathUrl('work', ['processes', 'proc 1', 'stdout.log']);
    expect(raw).toBe('work:///processes/proc%201/stdout.log');
    expect(parseScopedPathUrl(raw, 'work')).toMatchObject({ segments: ['processes', 'proc 1', 'stdout.log'], hadFragment: false });
  });

  it('round-trips canonical scoped roots', () => {
    for (const scheme of ['project', 'work', 'system']) {
      const raw = buildScopedPathUrl(scheme, []);
      expect(raw).toBe(`${scheme}:///`);
      expect(parseScopedPathUrl(raw, scheme)).toEqual({ segments: [], query: null, hadFragment: false });
    }
  });

  it('rejects non-canonical and structurally unsafe paths', () => {
    for (const raw of ['work://processes/x', 'work:///a//b', 'work:///a/', 'work:///./b', 'work:///../b', 'work:///a%2Fb', 'work:///a%5Cb', 'work:///a%3Fb', 'work:///a%23b', 'work:///%E0%A4%A']) {
      expect(() => parseScopedPathUrl(raw, 'work')).toThrow();
    }
  });

  it('separates query and fragment without using URL path normalization', () => {
    const parsed = parseScopedPathUrl('record:///brief.md?card=card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa&v=next#frag', 'record');
    expect(parsed.segments).toEqual(['brief.md']);
    expect(parsed.query?.get('card')).toBe('card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(parsed.hadFragment).toBe(true);
  });

  it('validates raw segments before emitting', () => {
    expect(() => buildScopedPathUrl('work', ['processes', 'a/b', 'stdout.log'])).toThrow('Unrepresentable segment');
    expect(() => buildScopedPathUrl('work', ['a?b'])).toThrow('Unrepresentable segment');
  });
});
