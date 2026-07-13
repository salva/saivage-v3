import { describe, expect, it } from '@jest/globals';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globProject, grepProject, MAX_READ_FILE_BYTES, MAX_READ_LINE_CHARS, MAX_READ_OUTPUT_BYTES, readProject } from '../../src/tools/project-file-tools.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-read-limits-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function ctx(projectRoot: string) {
  return { projectRoot, cardId: 'card-1', agentRole: 'executor' as const };
}

describe('project file tool read limits', () => {
  it('returns small file metadata without content', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'notes.txt'), 'hello\nworld', 'utf8');

    const result = await readProject(ctx(projectRoot), { path: 'notes.txt', metadata_only: true }) as Record<string, unknown>;

    expect(result).toEqual({ path: 'notes.txt', metadata_only: true, is_directory: false, size: 11, mtime: expect.any(String) });
  }));

  it('returns directory metadata with hidden entries filtered', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
    mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(projectRoot, 'visible.txt'), 'visible', 'utf8');

    const result = await readProject(ctx(projectRoot), { path: '.', metadata_only: true });

    expect(result).toEqual({ path: '.', metadata_only: true, is_directory: true, size: expect.any(Number), mtime: expect.any(String), entries_count: 1 });
  }));

  it('preserves non-scoped directory read, glob, and grep branches', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
    mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage', 'hidden.txt'), 'needle hidden', 'utf8');
    writeFileSync(join(projectRoot, 'node_modules', 'hidden.txt'), 'needle hidden', 'utf8');
    writeFileSync(join(projectRoot, 'visible.txt'), 'needle visible', 'utf8');

    const read = await readProject(ctx(projectRoot), { path: '.' }) as { path: string; entries: Array<{ name: string }>; total_entries: number };
    const metadata = await readProject(ctx(projectRoot), { path: '.', metadata_only: true });
    const glob = await globProject(ctx(projectRoot), { directory: '.', pattern: '**/*' }) as { directory: string; matches: string[] };
    const grep = await grepProject(ctx(projectRoot), { pattern: 'needle' }) as { matches: Array<{ path: string; preview: string }> };

    expect(read.path).toBe('.');
    expect(read.total_entries).toBe(1);
    expect(read.entries).toEqual([{ name: 'visible.txt', type: 'file' }]);
    expect(metadata).toEqual({ path: '.', metadata_only: true, is_directory: true, size: expect.any(Number), mtime: expect.any(String), entries_count: 1 });
    expect(glob).toMatchObject({ directory: '.', matches: ['visible.txt'] });
    expect(grep.matches).toEqual([{ path: 'visible.txt', line: 1, preview: 'needle visible' }]);
  }));

  it('matches work directory metadata count to normal listing', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage/work', 'processes', 'proc-1'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage/work', 'processes', 'proc-1', 'stdout.log'), 'out', 'utf8');

    const listing = await readProject(ctx(projectRoot), { path: 'work:///processes' }) as { total_entries: number };
    const metadata = await readProject(ctx(projectRoot), { path: 'work:///processes', metadata_only: true });

    expect(listing.total_entries).toBeGreaterThan(0);
    expect(metadata).toEqual({ path: 'work:///processes', metadata_only: true, is_directory: true, size: expect.any(Number), mtime: expect.any(String), entries_count: listing.total_entries });
  }));

  it('matches tmp directory metadata count to normal listing', async () => withTempProject(async (projectRoot) => {
    const tmpDir = join(projectRoot, '.saivage/work', 'cards', 'card-1', 'tmp', 'folder');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'a.txt'), 'a', 'utf8');
    writeFileSync(join(tmpDir, 'b.txt'), 'b', 'utf8');

    const listing = await readProject(ctx(projectRoot), { path: 'tmp:///card-1/folder' }) as { entries: Array<{ name: string }>; total_entries: number };
    const metadata = await readProject(ctx(projectRoot), { path: 'tmp:///card-1/folder', metadata_only: true });

    expect(listing.total_entries).toBe(2);
    expect(listing.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt']);
    expect(metadata).toEqual({ path: '.saivage/work/cards/card-1/tmp/folder', metadata_only: true, is_directory: true, size: expect.any(Number), mtime: expect.any(String), entries_count: listing.total_entries });
  }));

  it('returns metadata for a file larger than the inline read limit', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'large.txt'), Buffer.alloc(MAX_READ_FILE_BYTES + 1, 'a'));

    const result = await readProject(ctx(projectRoot), { path: 'large.txt', metadata_only: true }) as Record<string, unknown>;

    expect(result).toEqual({ path: 'large.txt', metadata_only: true, is_directory: false, size: MAX_READ_FILE_BYTES + 1, mtime: expect.any(String) });
    expect(result).not.toHaveProperty('too_large');
    expect(result).not.toHaveProperty('content');
  }));

  it('returns the too-large text shape without inline content', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'large.txt'), Buffer.alloc(MAX_READ_FILE_BYTES + 1, 'a'));

    const result = await readProject(ctx(projectRoot), { path: 'large.txt', offset: 3, limit: 7 });

    expect(result).toMatchObject({ path: 'large.txt', content: null, offset: 3, limit: 7, total_lines: null, truncated: true, too_large: true, size: MAX_READ_FILE_BYTES + 1, max_bytes: MAX_READ_FILE_BYTES, bytes: 0, message: expect.any(String) });
    expect((result as { message: string }).message).toContain('metadata_only');
    expect((result as { message: string }).message).toContain('grep');
    expect((result as { message: string }).message).toContain('glob');
  }));

  it('rejects binary files larger than the inline read limit', async () => withTempProject(async (projectRoot) => {
    const content = Buffer.alloc(MAX_READ_FILE_BYTES + 1, 0);
    content.write('not-text');
    writeFileSync(join(projectRoot, 'large.bin'), content);

    await expect(readProject(ctx(projectRoot), { path: 'large.bin' })).rejects.toThrow('Cannot read binary file as text');
  }));

  it('truncates a single huge line by line length only', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'huge-line.txt'), 'x'.repeat(MAX_READ_LINE_CHARS + 50), 'utf8');

    const result = await readProject(ctx(projectRoot), { path: 'huge-line.txt' }) as Record<string, unknown>;

    expect(result.content).toBe('x'.repeat(MAX_READ_LINE_CHARS));
    expect(result).toMatchObject({ lines_truncated: true, truncated: true, bytes: MAX_READ_LINE_CHARS });
    expect(result).not.toHaveProperty('content_truncated');
  }));

  it('caps many lines by output bytes only', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'many-lines.txt'), Array.from({ length: 2000 }, () => 'x'.repeat(200)).join('\n'), 'utf8');

    const result = await readProject(ctx(projectRoot), { path: 'many-lines.txt', limit: 2000 }) as Record<string, unknown>;

    expect(result).toMatchObject({ truncated: true, content_truncated: true, max_bytes: MAX_READ_OUTPUT_BYTES, bytes: MAX_READ_OUTPUT_BYTES });
    expect(result).not.toHaveProperty('lines_truncated');
  }));

  it('reports line-window truncation with size and returned bytes', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'lines.txt'), 'a\nb\nc', 'utf8');

    const result = await readProject(ctx(projectRoot), { path: 'lines.txt', offset: 1, limit: 1 });

    expect(result).toMatchObject({ content: 'b', offset: 1, limit: 1, total_lines: 3, truncated: true, size: 5, bytes: 1 });
  }));

  it('reports small file size and returned bytes', async () => withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, 'small.txt'), 'abc', 'utf8');

    const result = await readProject(ctx(projectRoot), { path: 'small.txt' });

    expect(result).toMatchObject({ content: 'abc', size: 3, bytes: 3 });
  }));

  it('caps work reads again after redaction expansion', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage/work', 'processes', 'proc-1'), { recursive: true });
    const secretAssignmentLine = Array.from({ length: 16 }, () => 'token=x').join(' ');
    writeFileSync(join(projectRoot, '.saivage/work', 'processes', 'proc-1', 'stdout.log'), Array.from({ length: 2000 }, () => secretAssignmentLine).join('\n'), 'utf8');

    const result = await readProject(ctx(projectRoot), { path: 'work:///processes/proc-1/stdout.log', limit: 2000 }) as { content: string; bytes: number; content_truncated: boolean; max_bytes: number };

    expect(result.content).not.toContain('token=x');
    expect(result.content).toContain('[REDACTED]');
    expect(result.content_truncated).toBe(true);
    expect(result.max_bytes).toBe(MAX_READ_OUTPUT_BYTES);
    expect(result.bytes).toBe(Buffer.byteLength(result.content, 'utf8'));
    expect(result.bytes).toBeLessThanOrEqual(MAX_READ_OUTPUT_BYTES);
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
    const prefix = `prefix-needle-${'x'.repeat(MAX_READ_LINE_CHARS)}`;
    writeFileSync(join(projectRoot, 'overlong.txt'), `${prefix}-suffix-needle`, 'utf8');

    const prefixResult = await grepProject(ctx(projectRoot), { path: 'overlong.txt', pattern: 'prefix-needle' }) as Record<string, unknown>;
    const suffixResult = await grepProject(ctx(projectRoot), { path: 'overlong.txt', pattern: 'suffix-needle' }) as Record<string, unknown>;

    expect(prefixResult).toMatchObject({
      matches: [{ path: 'overlong.txt', line: 1, preview: expect.stringMatching(/^prefix-needle-/) }],
      truncated: true,
      content_truncated: true,
      max_line_chars: MAX_READ_LINE_CHARS,
    });
    expect(((prefixResult.matches as Array<{ preview: string }>)[0]!.preview)).toHaveLength(500);
    expect(suffixResult).toEqual({ pattern: 'suffix-needle', matches: [], truncated: true, content_truncated: true, max_line_chars: MAX_READ_LINE_CHARS });
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
