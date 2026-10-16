import { describe, expect, it } from '@jest/globals';
import { prepareRecordPromptContent } from '../../../src/runtime/records/record-prompt-content.js';
import { canonicalJson } from '../../../src/schemas/index.js';
import { redactRecordPromptForOutbound } from '../../../src/redaction/index.js';

const url = 'record:///status.md?card=card-a';
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

describe('recordContent JSON-value preparation', () => {
  it.each([null, '', 'a'.repeat(32767), 'a'.repeat(32768), '😀'.repeat(8192)])(
    'preserves small/null substitutions byte for byte (%#)',
    (body) => {
      expect(prepareRecordPromptContent(body, url)).toBe(canonicalJson(body));
    },
  );

  it.each([
    'a'.repeat(32769),
    '😀é中\r\n'.repeat(6000),
    '"\\\n'.repeat(12000),
    `${'a'.repeat(8190)}\n${'b'.repeat(40000)}\\"END`,
  ])(
    'cuts the complete encoded display at scalar boundaries and freshly frames it (%#)',
    (body) => {
      const source = body;
      const display = redactRecordPromptForOutbound(canonicalJson(body));
      const substitution = prepareRecordPromptContent(body, url);
      const preview = JSON.parse(substitution) as string;
      expect(substitution).toBe(canonicalJson(preview));
      const [head, notice, tail] = preview.split('\n\n');
      expect(bytes(head!)).toBeLessThanOrEqual(8192);
      expect(bytes(tail!)).toBeLessThanOrEqual(8192);
      expect(display.startsWith(head!)).toBe(true);
      expect(display.endsWith(tail!)).toBe(true);
      expect(head! + tail!).not.toContain('\ufffd');
      const omitted = bytes(display) - bytes(head!) - bytes(tail!);
      expect(notice).toContain(`Middle omitted: ${omitted} UTF-8 display bytes.`);
      expect(notice).toContain(url);
      expect(notice).toContain('latest effective content');
      expect(bytes(substitution)).toBeGreaterThan(bytes(preview));
      expect(body).toBe(source);
    },
  );

  it.each([16383, 16384, 16385])('counts the actual post-redaction display at %i bytes', (size) => {
    // Encoded JSON quotes (2), encoded LF (2), and the existing placeholder (18).
    const body = `api_key=${'x'.repeat(40000)}\n${'b'.repeat(size - 22)}`;
    const display = redactRecordPromptForOutbound(canonicalJson(body));
    expect(bytes(display)).toBe(size);
    const preview = JSON.parse(prepareRecordPromptContent(body, url)) as string;
    if (size <= 16384) {
      expect(preview.startsWith(`${display}\n\n`)).toBe(true);
      expect(preview).toContain('No further middle elision was needed.');
      expect(preview.split(display)).toHaveLength(2);
      expect(preview).not.toContain('Middle omitted:');
    } else expect(preview).toContain('Middle omitted: 1 UTF-8 display bytes.');
  });

  it('retains the longest scalar-safe ends, not replacement characters or partial UTF-8', () => {
    const body = '😀'.repeat(10000);
    const preview = JSON.parse(prepareRecordPromptContent(body, url)) as string;
    const [head, , tail] = preview.split('\n\n');
    expect(head).toBe(`"${'😀'.repeat(2047)}`);
    expect(tail).toBe(`${'😀'.repeat(2047)}"`);
    expect(bytes(head!) + bytes('😀')).toBeGreaterThan(8192);
    expect(bytes(tail!) + bytes('😀')).toBeGreaterThan(8192);
  });

  it('allows a cut inside an opaque display escape while final substitution remains one complete JSON string', () => {
    const body = `${'a'.repeat(8190)}\n${'b'.repeat(40000)}`;
    const substitution = prepareRecordPromptContent(body, url);
    const preview = JSON.parse(substitution) as string;
    expect(preview.split('\n\n')[0]!.endsWith('\\')).toBe(true);
    expect(substitution).toBe(canonicalJson(preview));
    expect(JSON.parse(`{"payload": ${substitution}}`).payload).toBe(preview);
  });
});
