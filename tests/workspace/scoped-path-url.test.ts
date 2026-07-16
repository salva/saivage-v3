import { describe, expect, it } from '@jest/globals';

import { buildScopedPathUrl, parseScopedPathUrl } from '../../src/contracts/scoped-path-url.js';

describe('scoped path URL helper', () => {
  it('round-trips canonical triple-slash scoped path URLs', () => {
    const raw = buildScopedPathUrl('work', ['processes', 'proc 1', 'stdout.log']);
    expect(raw).toBe('work:///processes/proc%201/stdout.log');
    expect(parseScopedPathUrl(raw, 'work')).toMatchObject({ segments: ['processes', 'proc 1', 'stdout.log'], hadFragment: false });
  });

  it('rejects non-canonical and structurally unsafe paths', () => {
    for (const raw of ['work://processes/x', 'work:///', 'work:///a//b', 'work:///a/', 'work:///./b', 'work:///../b', 'work:///a%2Fb', 'work:///a%5Cb', 'work:///a%3Fb', 'work:///a%23b', 'work:///%E0%A4%A']) {
      expect(() => parseScopedPathUrl(raw, 'work')).toThrow();
    }
  });

  it('separates query and fragment without using URL path normalization', () => {
    const parsed = parseScopedPathUrl('record:///brief.md?card=11111111-1111-4111-8111-111111111111&v=next#frag', 'record');
    expect(parsed.segments).toEqual(['brief.md']);
    expect(parsed.query?.get('card')).toBe('11111111-1111-4111-8111-111111111111');
    expect(parsed.hadFragment).toBe(true);
  });

  it('validates raw segments before emitting', () => {
    expect(() => buildScopedPathUrl('work', [])).toThrow('requires at least one segment');
    expect(() => buildScopedPathUrl('work', ['processes', 'a/b', 'stdout.log'])).toThrow('Unrepresentable segment');
    expect(() => buildScopedPathUrl('work', ['a?b'])).toThrow('Unrepresentable segment');
  });
});
