import { describe, expect, it } from '@jest/globals';
import {
  SECRET_REDACTION_PLACEHOLDER,
  redactForOutbound,
  redactSnippetForOutbound,
  redactTextForOutbound,
} from '../../src/redaction/index.js';

describe('outbound redaction', () => {
  describe('structured values', () => {
    it('masks nested secret keys, handles arrays and cycles, and preserves non-secret values', () => {
      const circular: Record<string, unknown> = { safe: 'kept' };
      circular['self'] = circular;

      const result = redactForOutbound({
        title: 'visible',
        nested: {
          apiKey: 'synthetic-api-key',
          items: [{ password: 'synthetic-password', count: 3 }, 'safe'],
        },
        circular,
      });

      expect(result).toEqual({
        title: 'visible',
        nested: {
          apiKey: SECRET_REDACTION_PLACEHOLDER,
          items: [{ password: SECRET_REDACTION_PLACEHOLDER, count: 3 }, 'safe'],
        },
        circular: { safe: 'kept', self: '[Circular]' },
      });
    });

    it('uses the default depth bound of 8', () => {
      let input: Record<string, unknown> = { value: 'deep' };
      for (let depth = 0; depth < 8; depth += 1) input = { child: input };

      expect(redactForOutbound(input)).toEqual({
        child: {
          child: {
            child: {
              child: {
                child: {
                  child: {
                    child: {
                      child: '[MaxDepth]',
                    },
                  },
                },
              },
            },
          },
        },
      });
    });

    it('uses the default entry bound of 100 for arrays and objects', () => {
      const array = Array.from({ length: 101 }, (_, index) => index);
      const object = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`field${index}`, index]));

      const result = redactForOutbound({ array, object });

      expect(result.array).toEqual([...array.slice(0, 100), '[1 entries truncated]']);
      expect(result.object).toEqual({
        ...Object.fromEntries(Object.entries(object).slice(0, 100)),
        __truncated__: '1 entries truncated',
      });
    });

    it('honors caller-supplied depth and entry bounds with the exact truncation markers', () => {
      expect(redactForOutbound({
        nested: { child: { value: 'too deep' } },
        array: [1, 2, 3, 4],
        object: { first: 1, second: 2, third: 3 },
      }, { maxDepth: 2, maxEntries: 2 })).toEqual({
        nested: { child: '[MaxDepth]' },
        array: [1, 2, '[2 entries truncated]'],
        __truncated__: '1 entries truncated',
      });

      expect(redactForOutbound([1, 2, 3, 4], { maxEntries: 2 })).toEqual([1, 2, '[2 entries truncated]']);
      expect(redactForOutbound({ first: 1, second: 2, third: 3 }, { maxEntries: 2 })).toEqual({
        first: 1,
        second: 2,
        __truncated__: '1 entries truncated',
      });
    });
  });

  describe('text and dynamic conversion', () => {
    it('preserves plain text and environment references', () => {
      expect(redactTextForOutbound('ordinary diagnostic text')).toBe('ordinary diagnostic text');
      expect(redactTextForOutbound('{"apiKey":"${PROVIDER_API_KEY}"}')).toBe('{"apiKey":"${PROVIDER_API_KEY}"}');
    });

    it.each([
      ['JSON', '{"apiKey":"synthetic-json-secret","safe":"visible"}', '{"apiKey":"[REDACTED]","safe":"visible"}'],
      ['YAML', 'password: synthetic-yaml-secret\nsafe: visible', 'password: [REDACTED]\nsafe: visible'],
      ['escaped JSON', 'payload={\\"accessToken\\":\\"synthetic-escaped-secret\\"}', 'payload={\\"accessToken\\":\\"[REDACTED]\\"}'],
      ['inline assignment', 'run token=synthetic-assignment-secret now', 'run token=[REDACTED] now'],
      ['URL query credential', 'https://example.test/path?api_key=synthetic-query-secret&safe=yes', 'https://example.test/path?api_key=[REDACTED]'],
      ['bearer credential', 'Authorization: Bearer synthetic-bearer-secret', 'Authorization: [REDACTED]'],
      ['credential literals', 'sk-synthetic tid=synthetic ghu_synthetic rt_synthetic tok_synthetic', 'sk-[REDACTED] tid-[REDACTED] ghu-[REDACTED] rt-[REDACTED] tok-[REDACTED]'],
    ])('redacts %s text with the current exact output', (_kind, input, expected) => {
      expect(redactTextForOutbound(input)).toBe(expected);
    });

    it('converts Error and unserializable dynamic values before redaction', () => {
      expect(redactTextForOutbound(new Error('token=synthetic-error-secret'))).toBe('token=[REDACTED]');
      expect(redactTextForOutbound({ value: 1n })).toBe('[unserializable dynamic value]');
    });
  });

  it('redacts the complete text before applying the required snippet bound', () => {
    const rawSecret = 'synthetic-secret-that-crosses-the-boundary';
    const result = redactSnippetForOutbound(`prefix Bearer ${rawSecret} safe-tail`, 30);

    expect(result).toBe('prefix Bearer [REDACTED] safe-');
    expect(result).toHaveLength(30);
    expect(result).not.toContain(rawSecret);
  });
});
