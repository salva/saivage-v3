import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realFsPromises = await import('node:fs/promises');
const readdir = jest.fn(realFsPromises.readdir);
jest.unstable_mockModule('node:fs/promises', () => ({ ...realFsPromises, readdir }));

const { globProject, grepProject, readProject: readWithObservations } = await import('../../src/tools/project-file-tools.js');
const readProject = async (...args: Parameters<typeof readWithObservations>) => (await readWithObservations(...args)).data;

type Page<T> = { matches: { total: number; items: T[]; next: { item_index: number; item_byte_offset: number } | null } };
type GrepMatch = { path: string; line: number; preview: string };
const roots: string[] = [];
afterEach(() => {
  readdir.mockClear();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'project-search-scope-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'artifacts', 'fixtures'), { recursive: true });
  mkdirSync(join(root, 'artifacts', 'generated', 'deep'), { recursive: true });
  mkdirSync(join(root, 'artifacts', 'generated-fixtures'), { recursive: true });
  mkdirSync(join(root, 'nested', 'artifacts', 'generated'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.txt'), 'needle source');
  writeFileSync(join(root, 'artifacts', 'fixtures', 'required.txt'), 'needle fixture');
  writeFileSync(join(root, 'artifacts', 'generated', 'deep', 'stale.txt'), 'needle stale');
  writeFileSync(join(root, 'artifacts', 'generated-fixtures', 'similar.txt'), 'needle similar');
  writeFileSync(join(root, 'nested', 'artifacts', 'generated', 'nested.txt'), 'needle nested');
  return root;
}

function items<T>(result: unknown): T[] { return (result as Page<T>).matches.items; }

describe('project file search scope', () => {
  it('applies project ignore to absolute and aliased project targets, but not external native roots', async () => {
    const root = project();
    writeFileSync(join(root, '.saivage-search-ignore'), 'artifacts/generated\n');
    const outside = mkdtempSync(join(tmpdir(), 'external-search-scope-'));
    roots.push(outside);
    symlinkSync(join(root, 'artifacts/generated'), join(outside, 'alias'));
    const ctx = { projectRoot: root };
    for (const directory of [join(root, 'artifacts/generated'), join(outside, 'alias')]) {
      expect(items<string>(await globProject(ctx, { directory, pattern: '**/*.txt' }))).toEqual([]);
    }
    mkdirSync(join(outside, 'artifacts/generated'), { recursive: true });
    writeFileSync(join(outside, 'artifacts/generated/external.txt'), 'needle external');
    // The target's policy is not discovered or read, even when malformed.
    writeFileSync(join(outside, '.saivage-search-ignore'), Buffer.from([0xff]));
    expect(items<string>(await globProject(ctx, { directory: outside, pattern: '**/*.txt' }))).toEqual([join(outside, 'artifacts/generated/external.txt')]);
    expect(items<GrepMatch>(await grepProject(ctx, { path: outside, pattern: 'needle', include: '**/*.txt' }))).toEqual([{ path: join(outside, 'artifacts/generated/external.txt'), line: 1, preview: 'needle external' }]);
  });

  it('admits explicit dependency/build files while excluding those directories from recursive discovery and listing', async () => {
    const root = project();
    for (const directory of ['node_modules', 'dist', 'build', '__pycache__', '.git']) {
      mkdirSync(join(root, directory), { recursive: true });
      const file = join(root, directory, 'ordinary.txt');
      writeFileSync(file, 'needle explicit');
      await expect(readProject({ projectRoot: root }, { path: file })).resolves.toMatchObject({ content: { content: 'needle explicit' } });
      expect(items<string>(await globProject({ projectRoot: root }, { directory: file, pattern: '*.txt' }))).toEqual([`${directory}/ordinary.txt`]);
      expect(items<GrepMatch>(await grepProject({ projectRoot: root }, { path: file, pattern: 'needle' }))).toHaveLength(1);
    }
    const glob = items<string>(await globProject({ projectRoot: root }, { directory: root, pattern: '**/*.txt' }));
    expect(glob.some((path) => path.endsWith('/ordinary.txt'))).toBe(false);
    const listing = await readProject({ projectRoot: root }, { path: root }) as { entries: { items: { name: string }[] } };
    for (const name of ['node_modules', 'dist', 'build', '__pycache__', '.git']) {
      expect(listing.entries.items.map((entry) => entry.name)).not.toContain(name);
    }
  });

  it.each(['.', 'project:///'] as const)('prunes project-root searches for %s before ignored directory enumeration', async (directory) => {
    const root = project();
    writeFileSync(join(root, '.saivage-search-ignore'), '# target-owned output\nartifacts/generated\nfuture/output\n');

    const glob = items<string>(await globProject({ projectRoot: root }, { directory, pattern: '**/*.txt' }));
    const grep = items<GrepMatch>(await grepProject({ projectRoot: root }, { path: directory, pattern: 'needle' }));
    expect(glob).toEqual([
      'artifacts/fixtures/required.txt',
      'artifacts/generated-fixtures/similar.txt',
      'nested/artifacts/generated/nested.txt',
      'src/main.txt',
    ]);
    expect(grep.map((match) => match.path)).toEqual(glob);
    expect(readdir.mock.calls.map(([path]) => String(path))).not.toContain(join(root, 'artifacts', 'generated'));
  });

  it.each(['artifacts/generated', 'project:///artifacts/generated'] as const)('returns an empty page for excluded starting directory %s', async (directory) => {
    const root = project();
    writeFileSync(join(root, '.saivage-search-ignore'), 'artifacts/generated\n');
    expect(items<string>(await globProject({ projectRoot: root }, { directory, pattern: '**/*.txt' }))).toEqual([]);
    expect(items<GrepMatch>(await grepProject({ projectRoot: root }, { path: directory, pattern: 'needle' }))).toEqual([]);
    expect(readdir.mock.calls.map(([path]) => String(path))).not.toContain(join(root, 'artifacts', 'generated'));
  });

  it('reloads policy each invocation, preserves exact totals across stable pages, and ignores Git metadata', async () => {
    const root = project();
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'artifacts/fixtures\n');
    writeFileSync(join(root, '.saivage-search-ignore'), 'artifacts/generated\n');
    const first = await globProject({ projectRoot: root }, { directory: '.', pattern: '**/*.txt', max_results: 1 }) as Page<string>;
    const second = await globProject({ projectRoot: root }, { directory: '.', pattern: '**/*.txt', max_results: 1, position: first.matches.next! }) as Page<string>;
    expect(first.matches.total).toBe(4);
    expect(second.matches.total).toBe(4);
    expect(first.matches.items).toEqual(['artifacts/fixtures/required.txt']);

    writeFileSync(join(root, '.saivage-search-ignore'), 'artifacts/fixtures\n');
    const changed = items<string>(await globProject({ projectRoot: root }, { directory: '.', pattern: '**/*.txt' }));
    expect(changed).toContain('artifacts/generated/deep/stale.txt');
    expect(changed).not.toContain('artifacts/fixtures/required.txt');
  });

  it('prunes a valid BOM-free multibyte directory name', async () => {
    const root = project();
    mkdirSync(join(root, '输出', '旧结果'), { recursive: true });
    writeFileSync(join(root, '输出', '旧结果', 'stale.txt'), 'needle unicode stale');
    writeFileSync(join(root, '.saivage-search-ignore'), '输出/旧结果\n');
    const result = items<string>(await globProject({ projectRoot: root }, { directory: 'project:///', pattern: '**/*.txt' }));
    expect(result).not.toContain('输出/旧结果/stale.txt');
    expect(readdir.mock.calls.map(([path]) => String(path))).not.toContain(join(root, '输出', '旧结果'));
  });

  it('keeps explicit file search, direct reads, and nonrecursive directory listings unchanged', async () => {
    const root = project();
    writeFileSync(join(root, '.saivage-search-ignore'), 'artifacts/generated\n');
    expect(items<string>(await globProject({ projectRoot: root }, { directory: 'artifacts/generated/deep/stale.txt', pattern: '**/*.txt' }))).toEqual(['artifacts/generated/deep/stale.txt']);
    expect(items<GrepMatch>(await grepProject({ projectRoot: root }, { path: 'project:///artifacts/generated/deep/stale.txt', pattern: 'stale' }))).toEqual([{ path: 'artifacts/generated/deep/stale.txt', line: 1, preview: 'needle stale' }]);
    await expect(readProject({ projectRoot: root }, { path: 'artifacts/generated/deep/stale.txt' })).resolves.toMatchObject({ content: { content: 'needle stale' } });
    await expect(readProject({ projectRoot: root }, { path: 'artifacts' })).resolves.toMatchObject({ entries: { items: expect.arrayContaining([{ name: 'generated', type: 'dir' }]) } });
    await expect(readProject({ projectRoot: root }, { path: '.saivage-search-ignore' })).resolves.toMatchObject({ content: { content: 'artifacts/generated\n' } });
  });

  it('does not apply the project policy to system scope addressing the same directory', async () => {
    const root = project();
    writeFileSync(join(root, '.saivage-search-ignore'), 'artifacts/generated\n');
    const absolute = join(root, 'artifacts', 'generated');
    const system = `system:///${absolute.replace(/^\/+/, '')}`;
    expect(items<string>(await globProject({ projectRoot: root }, { directory: system, pattern: '**/*.txt' }))).toEqual([`${system}/deep/stale.txt`]);
    expect(items<GrepMatch>(await grepProject({ projectRoot: root }, { path: system, pattern: 'stale' }))).toEqual([{ path: `${system}/deep/stale.txt`, line: 1, preview: 'needle stale' }]);
  });

  it('fails before traversal for malformed bytes and a leading BOM', async () => {
    for (const bytes of [Buffer.from([0x61, 0x2f, 0xc3, 0x28]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('artifacts/generated')])]) {
      const root = project();
      writeFileSync(join(root, '.saivage-search-ignore'), bytes);
      readdir.mockClear();
      await expect(globProject({ projectRoot: root }, { directory: '.', pattern: '**/*' })).rejects.toThrow(/Invalid \.saivage-search-ignore/);
      expect(readdir).not.toHaveBeenCalled();
    }
  });
});
