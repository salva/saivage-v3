import { describe, expect, it } from '@jest/globals';
import { redactRecordPromptForOutbound } from '../../src/redaction/index.js';
import {
  redactSecretAssignmentsForOutbound,
  redactTextWithStablePrefixesForOutbound,
} from '../../src/redaction/text.js';

const secret = 'Q9vX2mR7p';
const encoded = (text: string) => JSON.stringify(text);

describe('conservative inline candidates with secret-only complete-value extension', () => {
  it.each([
    [String.raw`"\u001bapi_key=\"one two\""`, String.raw`"\u001bapi_key=[REDACTED] two\""`],
    [String.raw`"\udabcapi_key=\"one two\""`, String.raw`"\udabcapi_key=[REDACTED] two\""`],
    [String.raw`"\u000eapi_key=\"one two\" token=x"`, String.raw`"\u000eapi_key=[REDACTED] two\" token=[REDACTED]"`],
    [String.raw`"\tapi_key=x token=y"`, String.raw`"\tapi_key=[REDACTED] token=[REDACTED]"`],
    [String.raw`"\\tapi_key=x token=y"`, String.raw`"\\tapi_key=[REDACTED] token=[REDACTED]"`],
    [String.raw`"\t  api_key: x\nend"`, String.raw`"\t  api_key: [REDACTED]\nend"`],
    [String.raw`"\\t  api_key: x\nend"`, String.raw`"\\t  api_key: x\nend"`],
  ])('preserves exact eligible suffixes and boundary-rejected consumption (%#)', (input, output) => {
    expect(redactRecordPromptForOutbound(input)).toBe(output);
  });

  it('skips failed long key/indentation runs without losing following candidates', () => {
    for (const run of ['a'.repeat(4096), 'a0_-'.repeat(1024), ' '.repeat(4096), '\\'.repeat(4096)]) {
      for (const separator of [' ', '\n', '\t']) {
        const text = `token=first ${run}${separator}api_key="last value"`;
        const expected = `token=[REDACTED] ${run}${separator}api_key=[REDACTED]`;
        expect(redactSecretAssignmentsForOutbound(text)).toBe(expected);
        expect(redactRecordPromptForOutbound(encoded(text))).toBe(encoded(expected));
      }
    }
    const key = `a0_-${'token-password-'.repeat(128)}auth`;
    expect(redactSecretAssignmentsForOutbound(`${key}=x`)).toBe(`${key}=[REDACTED]`);
    expect(redactSecretAssignmentsForOutbound(`1${key}=x-token=y`)).toBe(
      `1a0_-${'token-password-'.repeat(128)}auth=[REDACTED]`,
    );
  });

  it.each([
    ['note="prefix\\" token=synthetic" tail=x', {
      text: 'note="prefix\\" token=[REDACTED] tail=x',
      maxPrefixEnd: 38,
      indivisibleSpans: [{ start: 0, end: 14 }, { start: 15, end: 31 }, { start: 32, end: 38 }],
    }],
    ['password="prefix\\" token=synthetic" tail=x', {
      text: 'password=[REDACTED] tail=x',
      maxPrefixEnd: 26,
      indivisibleSpans: [{ start: 0, end: 19 }, { start: 20, end: 26 }],
    }],
    ['1api_key=x-token=y auth=z', {
      text: '1api_key=x-token=[REDACTED] auth=[REDACTED]',
      maxPrefixEnd: 43,
      indivisibleSpans: [{ start: 9, end: 27 }, { start: 28, end: 43 }],
    }],
    ['token: ${Bearer example}', {
      text: 'token: ${Bearer [REDACTED]',
      maxPrefixEnd: 0,
      indivisibleSpans: [],
    }],
    ['api_key=[REDACTED] note=x token=y', {
      text: 'api_key=[REDACTED] note=x token=[REDACTED]',
      maxPrefixEnd: 42,
      indivisibleSpans: [{ start: 0, end: 18 }, { start: 19, end: 25 }, { start: 26, end: 42 }],
    }],
  ] as const)('certifies original final-text candidates, not extended quotes (%#)', (input, result) => {
    expect(redactTextWithStablePrefixesForOutbound(input)).toEqual(result);
  });

  it.each([
    `api_key="prefix\\" ${secret}"`,
    `api_key="prefix\\\n${secret}"`,
    `api_key="prefix\\\r${secret}"`,
    `api_key="prefix\\\r\n${secret}"`,
    `api_key="prefix\\\u2028${secret}"`,
    `api_key="prefix\\\\\\" ${secret}"`,
  ])('masks the whole complete escaped secret value: %j', (text) => {
    expect(redactSecretAssignmentsForOutbound(text)).toBe('api_key=[REDACTED]');
    expect(redactRecordPromptForOutbound(encoded(text))).toBe(encoded('api_key=[REDACTED]'));
  });

  it('retains conservative masking for incomplete quoted opaque text (R9)', () => {
    const text = `api_key="prefix ${secret}\\"`;
    expect(redactSecretAssignmentsForOutbound(text)).toBe('api_key=[REDACTED]');
    expect(redactRecordPromptForOutbound(encoded(text))).toBe(encoded('api_key=[REDACTED]'));
  });

  it('does not extend a non-secret candidate past the next secret start (R10)', () => {
    const text = `note="prefix\\" api_key=${secret}"`;
    const expected = 'note="prefix\\" api_key=[REDACTED]';
    expect(redactSecretAssignmentsForOutbound(text)).toBe(expected);
    expect(redactRecordPromptForOutbound(encoded(text))).toBe(encoded(expected));
    expect(redactSecretAssignmentsForOutbound(text.replace('note=', 'password='))).toBe(
      'password=[REDACTED]',
    );
    expect(redactRecordPromptForOutbound(encoded(text.replace('note=', 'password=')))).toBe(
      encoded('password=[REDACTED]'),
    );
  });

  it('keeps unchanged placeholders, single/unquoted syntax and subsequent starts', () => {
    const text = `api_key=[REDACTED] note="prefix\\" token=${secret} password='plain text' auth=other`;
    const expected =
      'api_key=[REDACTED] note="prefix\\" token=[REDACTED] password=[REDACTED] auth=[REDACTED]';
    expect(redactSecretAssignmentsForOutbound(text)).toBe(expected);
    expect(redactRecordPromptForOutbound(encoded(text))).toBe(encoded(expected));
    expect(redactSecretAssignmentsForOutbound('api_key="paired\\\\" ordinary')).toBe(
      'api_key=[REDACTED] ordinary',
    );
    expect(redactRecordPromptForOutbound(encoded('api_key="paired\\\\" ordinary'))).toBe(
      encoded('api_key=[REDACTED] ordinary'),
    );
  });

  it('keeps encoded unit and represented-word boundary rejection conservative', () => {
    // No represented word boundary after the preceding digit.
    const text = `1api_key="prefix\\" token=${secret}"`;
    const publicText = redactRecordPromptForOutbound(encoded(text));
    expect(publicText).toBe(encoded('1api_key="prefix\\" token=[REDACTED]'));
    expect(redactRecordPromptForOutbound(encoded(`\tapi_key=${secret}`))).toBe(
      encoded('\tapi_key=[REDACTED]'),
    );
  });
});
