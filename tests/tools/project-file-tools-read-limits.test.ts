import { describe, expect, it } from '@jest/globals';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../../src/schemas/index.js';
import { globProject, grepProject, MAX_GREP_LINE_CHARS, MAX_READ_FILE_BYTES, readProject } from '../../src/tools/project-file-tools.js';
import { DISCOVERY_RESPONSE_MAX_BYTES } from '../../src/contracts/builtin-tool-inputs.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-read-limits-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function ctx(projectRoot: string) {
  return { projectRoot, cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', agentName: 'executor' as const };
}

const envelopeBytes = (data: unknown): number => Buffer.byteLength(canonicalJson({ success: true, data }), 'utf8');
const textSlice = (value: unknown): { content: string; utf8_bytes: number; offset_bytes: number; next_offset_bytes: number } => {
  if (typeof value !== 'object' || value === null) throw new Error('expected a text slice');
  return value as { content: string; utf8_bytes: number; offset_bytes: number; next_offset_bytes: number };
};

describe('project file tool read limits', () => {
  it('returns small file metadata with sliced path text only', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'notes.txt'), 'hello\nworld', 'utf8');

    const result = await readProject(ctx(projectRoot), { path: 'notes.txt', metadata_only: true }) as Record<string, unknown>;

    expect(result).toEqual({ path: { content: 'notes.txt', utf8_bytes: 9, offset_bytes: 0, next_offset_bytes: 9 }, metadata_only: true, is_directory: false, size: 11, mtime: expect.any(String) });
  }));

  it('returns directory metadata with hidden entries filtered', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
    mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(projectRoot, 'visible.txt'), 'visible', 'utf8');

    const result = await readProject(ctx(projectRoot), { path: '.', metadata_only: true }) as Record<string, unknown>;

    expect(result).toMatchObject({ metadata_only: true, is_directory: true, size: expect.any(Number), mtime: expect.any(String), entries_count: 1 });
    expect(textSlice(result.path).content).toBe('.');
  }));

  it('preserves non-scoped directory read, glob, and grep branches', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
    mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage', 'hidden.txt'), 'needle hidden', 'utf8');
    writeFileSync(join(projectRoot, 'node_modules', 'hidden.txt'), 'needle hidden', 'utf8');
    writeFileSync(join(projectRoot, 'visible.txt'), 'needle visible', 'utf8');

    const read = await readProject(ctx(projectRoot), { path: '.' }) as Record<string, unknown>;
    const metadata = await readProject(ctx(projectRoot), { path: '.', metadata_only: true }) as Record<string, unknown>;
    const glob = await globProject(ctx(projectRoot), { directory: '.', pattern: '**/*' }) as { directory: string; matches: string[] };
    const grep = await grepProject(ctx(projectRoot), { pattern: 'needle' }) as { matches: Array<{ path: string; preview: string }> };

    expect(read.path).toBe('.');
    expect(read.total_entries).toBe(1);
    expect(read.entries).toEqual({ total: 1, position: { item_index: 0, item_byte_offset: 0 }, returned: 1, next: null, items: [{ name: 'visible.txt', type: 'file' }] });
    expect(metadata.entries_count).toBe(1);
    expect(glob).toMatchObject({ directory: '.', matches: ['visible.txt'] });
    expect(grep.matches).toEqual([{ path: 'visible.txt', line: 1, preview: 'needle visible' }]);
  }));

  it('matches work directory metadata count to normal listing', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage/work', 'processes', 'proc-1'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage/work', 'processes', 'proc-1', 'stdout.log'), 'out', 'utf8');

    const listing = await readProject(ctx(projectRoot), { path: 'work:///processes' }) as { total_entries: number };
    const metadata = await readProject(ctx(projectRoot), { path: 'work:///processes', metadata_only: true }) as Record<string, unknown>;

    expect(listing.total_entries).toBeGreaterThan(0);
    expect(metadata.entries_count).toBe(listing.total_entries);
    expect(textSlice(metadata.path).content).toBe('work:///processes');
  }));

  it('matches tmp directory metadata count to normal listing', async () => withTempProject(async (projectRoot) => {
    const tmpDir = join(projectRoot, '.saivage/work', 'cards', 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tmp', 'folder');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'a.txt'), 'a', 'utf8');
    writeFileSync(join(tmpDir, 'b.txt'), 'b', 'utf8');

    const listing = await readProject(ctx(projectRoot), { path: 'tmp:///card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/folder' }) as { entries: { items: string[]; total: number }; total_entries: number };
    const metadata = await readProject(ctx(projectRoot), { path: 'tmp:///card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/folder', metadata_only: true }) as Record<string, unknown>;

    expect(listing.total_entries).toBe(2);
    expect(listing.entries).toMatchObject({ total: 2, returned: 2 });
    expect(metadata.entries_count).toBe(listing.total_entries);
    expect(textSlice(metadata.path).content).toBe('.saivage/work/cards/card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/tmp/folder');
  }));

  it('returns metadata for a file larger than the inline read limit', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'large.txt'), Buffer.alloc(MAX_READ_FILE_BYTES + 1, 'a'));

    const result = await readProject(ctx(projectRoot), { path: 'large.txt', metadata_only: true }) as Record<string, unknown>;

    expect(result).toMatchObject({ metadata_only: true, is_directory: false, size: MAX_READ_FILE_BYTES + 1, mtime: expect.any(String) });
    expect(result).not.toHaveProperty('too_large');
    expect(result).not.toHaveProperty('content');
  }));

  it('returns the too-large refusal without inline content', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'large.txt'), Buffer.alloc(MAX_READ_FILE_BYTES + 1, 'a'));

    const result = await readProject(ctx(projectRoot), { path: 'large.txt' }) as Record<string, unknown>;

    expect(result).toMatchObject({ path: 'large.txt', content: null, total_bytes: MAX_READ_FILE_BYTES + 1, too_large: true, max_bytes: MAX_READ_FILE_BYTES, message: expect.any(String) });
    expect(envelopeBytes(result)).toBeLessThanOrEqual(DISCOVERY_RESPONSE_MAX_BYTES);
  }));

  it('rejects binary files larger than the inline read limit', async () => withTempProject(async (projectRoot) => {
    const content = Buffer.alloc(MAX_READ_FILE_BYTES + 1, 0);
    content.write('not-text');
    writeFileSync(join(projectRoot, 'large.bin'), content);

    await expect(readProject(ctx(projectRoot), { path: 'large.bin' })).rejects.toThrow('Cannot read binary file as text');
  }));

  it('slices a single huge line on UTF-8 boundaries within the byte budget', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'huge-line.txt'), 'x'.repeat(60000), 'utf8');

    const result = await readProject(ctx(projectRoot), { path: 'huge-line.txt' }) as Record<string, unknown>;

    const slice = textSlice(result.content);
    expect(slice.offset_bytes).toBe(0);
    expect(slice.utf8_bytes).toBeGreaterThan(0);
    expect(slice.next_offset_bytes).toBe(slice.utf8_bytes);
    expect(slice.content).toBe('x'.repeat(slice.utf8_bytes));
    expect(result.total_bytes).toBe(60000);
    expect(envelopeBytes(result)).toBeLessThanOrEqual(DISCOVERY_RESPONSE_MAX_BYTES);
  }));

  it('continues a text read exactly at the emitted byte offset', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'lines.txt'), 'a\nb\nc', 'utf8');

    const first = await readProject(ctx(projectRoot), { path: 'lines.txt', response_bytes: 600 }) as Record<string, unknown>;
    expect(textSlice(first.content)).toEqual({ content: 'a\nb\nc', utf8_bytes: 5, offset_bytes: 0, next_offset_bytes: 5 });

    const second = await readProject(ctx(projectRoot), { path: 'lines.txt', position: { kind: 'text', byte_offset: 5 } }) as Record<string, unknown>;
    expect(textSlice(second.content)).toEqual({ content: '', utf8_bytes: 0, offset_bytes: 5, next_offset_bytes: 5 });
  }));

  it('pages a large text file through byte offsets without exceeding the envelope', async () => withTempProject(async (projectRoot) => {
    const payload = Array.from({ length: 2000 }, () => 'x'.repeat(200)).join('\n');
    writeFileSync(join(projectRoot, 'many-lines.txt'), payload, 'utf8');

    let offset = 0;
    const slices: string[] = [];
    for (;;) {
      const result = await readProject(ctx(projectRoot), { path: 'many-lines.txt', response_bytes: 2048, position: { kind: 'text', byte_offset: offset } }) as Record<string, unknown>;
      expect(envelopeBytes(result)).toBeLessThanOrEqual(2048);
      const slice = textSlice(result.content);
      expect(slice.offset_bytes).toBe(offset);
      slices.push(slice.content);
      if (slice.next_offset_bytes >= (result.total_bytes as number)) break;
      offset = slice.next_offset_bytes;
    }

    expect(slices.join('')).toBe(payload);
  }));

  it('keeps every read branch inside the exact envelope budget', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'small.txt'), 'abc', 'utf8');
    const small = await readProject(ctx(projectRoot), { path: 'small.txt' }) as Record<string, unknown>;
    expect(textSlice(small.content).content).toBe('abc');
    expect(small.size).toBe(3);
    expect(envelopeBytes(small)).toBeLessThanOrEqual(DISCOVERY_RESPONSE_MAX_BYTES);

    const unicode = 'título ✓ — ' + 'é'.repeat(40000);
    writeFileSync(join(projectRoot, 'unicode.txt'), unicode, 'utf8');
    const unicodeRead = await readProject(ctx(projectRoot), { path: 'unicode.txt', response_bytes: 700 }) as Record<string, unknown>;
    const slice = textSlice(unicodeRead.content);
    expect(envelopeBytes(unicodeRead)).toBeLessThanOrEqual(700);
    expect(unicode.startsWith(slice.content)).toBe(true);
    expect(slice.next_offset_bytes).toBeLessThan(unicodeRead.total_bytes as number);
  }));

  it('rejects a path/position-kind mismatch as input validation', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'small.txt'), 'abc', 'utf8');
    mkdirSync(join(projectRoot, 'dir'), { recursive: true });

    await expect(readProject(ctx(projectRoot), { path: 'small.txt', position: { kind: 'collection', item_index: 0, item_byte_offset: 0 } })).rejects.toThrow(/requires a text position/);
    await expect(readProject(ctx(projectRoot), { path: 'dir', position: { kind: 'text', byte_offset: 0 } })).rejects.toThrow(/requires a collection position/);
  }));

  it('pages wide directories through stateless collection positions', async () => withTempProject(async (projectRoot) => {
    for (let index = 0; index < 120; index += 1) writeFileSync(join(projectRoot, `entry-${String(index).padStart(3, '0')}.txt`), 'x', 'utf8');

    const first = await readProject(ctx(projectRoot), { path: '.', response_bytes: 700 }) as { entries: { total: number; returned: number; next: { item_index: number; item_byte_offset: number } | null; items: string[] }; total_entries: number };
    expect(first.total_entries).toBe(120);
    expect(first.entries.returned).toBeLessThan(120);
    expect(first.entries.next).toEqual({ item_index: first.entries.returned, item_byte_offset: 0 });

    let position = first.entries.next;
    let seen = first.entries.items.length;
    while (position !== null) {
      const page = await readProject(ctx(projectRoot), { path: '.', response_bytes: 700, position: { kind: 'collection', item_index: position.item_index, item_byte_offset: position.item_byte_offset } }) as { entries: { returned: number; next: { item_index: number; item_byte_offset: number } | null; items: string[] } };
      seen += page.entries.returned;
      position = page.entries.next;
    }
    expect(seen).toBe(120);
  }));

  it('caps work reads by the exact envelope after redaction', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage/work', 'processes', 'proc-1'), { recursive: true });
    const secretAssignmentLine = Array.from({ length: 16 }, () => 'token=x').join(' ');
    writeFileSync(join(projectRoot, '.saivage/work', 'processes', 'proc-1', 'stdout.log'), Array.from({ length: 2000 }, () => secretAssignmentLine).join('\n'), 'utf8');

    const result = await readProject(ctx(projectRoot), { path: 'work:///processes/proc-1/stdout.log', response_bytes: 4096 }) as Record<string, unknown>;

    const slice = textSlice(result.content);
    expect(slice.content).not.toContain('token=x');
    expect(slice.content).toContain('[REDACTED]');
    expect(envelopeBytes(result)).toBeLessThanOrEqual(4096);
  }));

  it('streams files larger than the inline read limit and finds matches beyond it', async () => withTempProject(async (projectRoot) => {
    const beforeMatch = Buffer.from('a\n'.repeat(Math.ceil(MAX_READ_FILE_BYTES / 2) + 1));
    writeFileSync(join(projectRoot, 'oversized.txt'), Buffer.concat([beforeMatch, Buffer.from('needle beyond inline limit\n')]));

    const result = await grepProject(ctx(projectRoot), { path: 'oversized.txt', pattern: 'needle beyond' });

    expect(result).toMatchObject({ matches: [{ path: 'oversized.txt', line: Math.ceil(MAX_READ_FILE_BYTES / 2) + 2, preview: 'needle beyond inline limit' }], truncated: false });
  }));

  it('has no whole-file synchronous read in the grep scanner', () => {
    const source = readFileSync(join(process.cwd(), 'src/tools/project-file-tools.ts'), 'utf8');
    const scanner = source.slice(source.indexOf('async function scanFile'), source.indexOf('export async function editProject'));

    expect(scanner).toContain('createReadStream');
    expect(scanner).not.toContain('readFileSync');
  });

  it('decodes tokens and newline delimiters split across stream chunks', async () => withTempProject(async (projectRoot) => {
    const chunkPrefix = 'a\n'.repeat(32767);
    writeFileSync(join(projectRoot, 'token-boundary.txt'), Buffer.concat([Buffer.from(`${chunkPrefix}x`), Buffer.from('éneedle\n')]));
    writeFileSync(join(projectRoot, 'newline-boundary.txt'), `${chunkPrefix}x\r\nneedle-final`, 'utf8');

    const token = await grepProject(ctx(projectRoot), { path: 'token-boundary.txt', pattern: 'xéneedle' });
    const newline = await grepProject(ctx(projectRoot), { path: 'newline-boundary.txt', pattern: 'needle-final' });

    expect(token).toMatchObject({ matches: [{ line: 32768, preview: 'xéneedle' }], truncated: false });
    expect(newline).toMatchObject({ matches: [{ line: 32769, preview: 'needle-final' }], truncated: false });
  }));

  it('counts CRLF and final unterminated lines accurately', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'lines.txt'), 'first\r\nneedle two\r\nthird\nneedle final', 'utf8');

    const result = await grepProject(ctx(projectRoot), { path: 'lines.txt', pattern: 'needle' });

    expect(result).toEqual({
      pattern: 'needle',
      matches: [
        { path: 'lines.txt', line: 2, preview: 'needle two' },
        { path: 'lines.txt', line: 4, preview: 'needle final' },
      ],
      truncated: false,
    });
  }));

  it('searches only an overlong line prefix and reports truthful truncation metadata', async () => withTempProject(async (projectRoot) => {
    const prefix = `prefix-needle-${'x'.repeat(MAX_GREP_LINE_CHARS)}`;
    writeFileSync(join(projectRoot, 'overlong.txt'), `${prefix}-suffix-needle`, 'utf8');

    const prefixResult = await grepProject(ctx(projectRoot), { path: 'overlong.txt', pattern: 'prefix-needle' }) as Record<string, unknown>;
    const suffixResult = await grepProject(ctx(projectRoot), { path: 'overlong.txt', pattern: 'suffix-needle' }) as Record<string, unknown>;

    expect(prefixResult).toMatchObject({
      matches: [{ path: 'overlong.txt', line: 1, preview: expect.stringMatching(/^prefix-needle-/) }],
      truncated: true,
      content_truncated: true,
      max_line_chars: MAX_GREP_LINE_CHARS,
    });
    expect(((prefixResult.matches as Array<{ preview: string }>)[0]!.preview)).toHaveLength(500);
    expect(suffixResult).toEqual({ pattern: 'suffix-needle', matches: [], truncated: true, content_truncated: true, max_line_chars: MAX_GREP_LINE_CHARS });
  }));

  it('stops before opening later files at the result limit', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'a-match.txt'), 'needle\n' + 'ignored\n'.repeat(10000), 'utf8');
    const unreadable = join(projectRoot, 'z-unreadable.txt');
    writeFileSync(unreadable, 'needle', 'utf8');
    chmodSync(unreadable, 0);

    try {
      const result = await grepProject(ctx(projectRoot), { pattern: 'needle', max_results: 1 });
      expect(result).toEqual({ pattern: 'needle', matches: [{ path: 'a-match.txt', line: 1, preview: 'needle' }], truncated: true });
    } finally {
      chmodSync(unreadable, 0o600);
    }
  }));

  it('does not stat, enumerate, or open a path when max_results is zero', async () => withTempProject(async (projectRoot) => {
    const result = await grepProject(ctx(projectRoot), { path: 'missing-directory', pattern: 'needle', max_results: 0 });

    expect(result).toEqual({ pattern: 'needle', matches: [], truncated: true });
  }));

  it('skips binary head samples and continues to later text files', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'a-binary.bin'), Buffer.from([0, 1, 2, 3, 110, 101, 101, 100, 108, 101]));
    writeFileSync(join(projectRoot, 'b-text.txt'), 'needle text', 'utf8');

    const result = await grepProject(ctx(projectRoot), { pattern: 'needle' });

    expect(result).toEqual({ pattern: 'needle', matches: [{ path: 'b-text.txt', line: 1, preview: 'needle text' }], truncated: false });
  }));

  it('redacts streamed work grep previews while preserving path and line', async () => withTempProject(async (projectRoot) => {
    const workDir = join(projectRoot, '.saivage/work', 'processes', 'proc-1');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'stdout.log'), 'ordinary output\nAuthorization: Bearer secret-token needle\n', 'utf8');

    const result = await grepProject(ctx(projectRoot), { path: 'work:///processes/proc-1/stdout.log', pattern: 'Authorization' });

    expect(result).toEqual({
      pattern: 'Authorization',
      matches: [{ path: 'work:///processes/proc-1/stdout.log', line: 2, preview: expect.stringContaining('[REDACTED]') }],
      truncated: false,
    });
    expect((result as { matches: Array<{ preview: string }> }).matches[0]!.preview).not.toContain('secret-token');
  }));
});
