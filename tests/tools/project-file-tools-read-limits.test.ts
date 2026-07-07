import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    mkdirSync(join(projectRoot, '.saivage-work', 'processes', 'proc-1'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage-work', 'processes', 'proc-1', 'stdout.log'), 'out', 'utf8');

    const listing = await readProject(ctx(projectRoot), { path: 'work:///processes' }) as { total_entries: number };
    const metadata = await readProject(ctx(projectRoot), { path: 'work:///processes', metadata_only: true });

    expect(listing.total_entries).toBeGreaterThan(0);
    expect(metadata).toEqual({ path: 'work:///processes', metadata_only: true, is_directory: true, size: expect.any(Number), mtime: expect.any(String), entries_count: listing.total_entries });
  }));

  it('matches tmp directory metadata count to normal listing', async () => withTempProject(async (projectRoot) => {
    const tmpDir = join(projectRoot, '.saivage-work', 'cards', 'card-1', 'tmp', 'folder');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'a.txt'), 'a', 'utf8');
    writeFileSync(join(tmpDir, 'b.txt'), 'b', 'utf8');

    const listing = await readProject(ctx(projectRoot), { path: 'tmp:///card-1/folder' }) as { entries: Array<{ name: string }>; total_entries: number };
    const metadata = await readProject(ctx(projectRoot), { path: 'tmp:///card-1/folder', metadata_only: true });

    expect(listing.total_entries).toBe(2);
    expect(listing.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt']);
    expect(metadata).toEqual({ path: '.saivage-work/cards/card-1/tmp/folder', metadata_only: true, is_directory: true, size: expect.any(Number), mtime: expect.any(String), entries_count: listing.total_entries });
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
    mkdirSync(join(projectRoot, '.saivage-work', 'processes', 'proc-1'), { recursive: true });
    const secretAssignmentLine = Array.from({ length: 16 }, () => 'token=x').join(' ');
    writeFileSync(join(projectRoot, '.saivage-work', 'processes', 'proc-1', 'stdout.log'), Array.from({ length: 2000 }, () => secretAssignmentLine).join('\n'), 'utf8');

    const result = await readProject(ctx(projectRoot), { path: 'work:///processes/proc-1/stdout.log', limit: 2000 }) as { content: string; bytes: number; content_truncated: boolean; max_bytes: number };

    expect(result.content).not.toContain('token=x');
    expect(result.content).toContain('[REDACTED]');
    expect(result.content_truncated).toBe(true);
    expect(result.max_bytes).toBe(MAX_READ_OUTPUT_BYTES);
    expect(result.bytes).toBe(Buffer.byteLength(result.content, 'utf8'));
    expect(result.bytes).toBeLessThanOrEqual(MAX_READ_OUTPUT_BYTES);
  }));
});
