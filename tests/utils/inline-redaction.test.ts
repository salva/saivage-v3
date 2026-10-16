import { describe, expect, it } from '@jest/globals';
import { redactRecordPromptForOutbound } from '../../src/redaction/index.js';
import { redactSecretAssignmentsForOutbound } from '../../src/redaction/text.js';

const secret = 'Q9vX2mR7p';
const encoded = (text: string) => JSON.stringify(text);

describe('conservative inline candidates with secret-only complete-value extension', () => {
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
