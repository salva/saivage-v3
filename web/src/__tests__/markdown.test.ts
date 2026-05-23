import { describe, expect, it } from 'vitest';
import { splitMarkdownSegments } from '../utils/markdown';

describe('splitMarkdownSegments', () => {
  it('returns empty array for empty input', () => {
    expect(splitMarkdownSegments('')).toEqual([]);
  });

  it('returns a single text segment for plain text', () => {
    const out = splitMarkdownSegments('hello world');
    expect(out).toEqual([{ kind: 'text', content: 'hello world' }]);
  });

  it('parses a fenced block with language', () => {
    const out = splitMarkdownSegments('```json\n{"a":1}\n```');
    expect(out).toEqual([{ kind: 'code', content: '{"a":1}\n', language: 'json' }]);
  });

  it('parses a fenced block without language', () => {
    const out = splitMarkdownSegments('```\nplain\n```');
    expect(out).toEqual([{ kind: 'code', content: 'plain\n', language: undefined }]);
  });

  it('handles mixed text + fence + text', () => {
    const out = splitMarkdownSegments('before\n```bash\nls -al\n```\nafter');
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ kind: 'text', content: 'before\n' });
    expect(out[1]).toEqual({ kind: 'code', content: 'ls -al\n', language: 'bash' });
    expect(out[2]).toEqual({ kind: 'text', content: '\nafter' });
  });

  it('parses single inline backtick code', () => {
    const out = splitMarkdownSegments('see `foo()` here');
    expect(out).toEqual([
      { kind: 'text', content: 'see ' },
      { kind: 'inline-code', content: 'foo()' },
      { kind: 'text', content: ' here' },
    ]);
  });

  it('parses multiple inline tokens on one line', () => {
    const out = splitMarkdownSegments('`a` and `b` and `c`');
    const kinds = out.map((s) => s.kind);
    expect(kinds).toEqual(['inline-code', 'text', 'inline-code', 'text', 'inline-code']);
  });

  it('does not split inline code inside fenced blocks', () => {
    const out = splitMarkdownSegments('```\nhas `tick` inside\n```');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('code');
    expect((out[0] as { content: string }).content).toBe('has `tick` inside\n');
  });
});
