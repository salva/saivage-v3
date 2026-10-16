import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { applyProjectPatch, authorizeWriteProject, editProject, globProject, grepProject, MAX_READ_FILE_BYTES, readProject, readWorkspaceImageSource, writeProject } from '../../src/tools/project-file-tools.js';
import { readWorkspaceInputSchema } from '../../src/contracts/builtin-tool-inputs.js';
import { buildScopedPathUrl } from '../../src/contracts/scoped-path-url.js';

type Position = { item_index: number; item_byte_offset: number };
type Page<T> = { matches: { total: number; items: T[]; next: Position | null } };
type Match = { path: string; line: number; preview: string };
const systemUrl = (path: string) => buildScopedPathUrl('system', path.split('/').filter(Boolean));

describe('ordinary absolute agent reads and discovery', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function fixture() {
    const parent = mkdtempSync(join(tmpdir(), 'agent-read-siblings-'));
    roots.push(parent);
    const projectRoot = join(parent, 'project');
    const sibling = join(parent, 'sibling');
    mkdirSync(projectRoot);
    mkdirSync(sibling);
    writeFileSync(join(projectRoot, 'local.txt'), 'needle local');
    writeFileSync(join(sibling, 'a.txt'), 'needle sibling');
    writeFileSync(join(sibling, 'b.txt'), 'needle second');
    symlinkSync(sibling, join(projectRoot, 'linked'));
    return { projectRoot, sibling };
  }

  it('reads sibling and independently allocated /tmp paths through native, normalized, URL and explicit symlink roots', async () => {
    const { projectRoot, sibling } = fixture();
    const system = mkdtempSync('/tmp/saivage-native-read-');
    roots.push(system);
    writeFileSync(join(system, 'system.txt'), 'needle system');
    const ctx = { projectRoot };
    for (const path of [join(sibling, 'a.txt'), `${projectRoot}/../sibling/./a.txt`, systemUrl(join(sibling, 'a.txt')), 'linked/a.txt']) {
      await expect(readProject(ctx, { path })).resolves.toMatchObject({ data: { content: { content: 'needle sibling' } } });
    }
    await expect(readProject(ctx, { path: join(system, 'system.txt') })).resolves.toMatchObject({ data: { content: { content: 'needle system' } } });
    for (const directory of [sibling, systemUrl(sibling), 'linked', system]) {
      const result = await globProject(ctx, { directory, pattern: '*.txt' }) as Page<string>;
      expect(result.matches.total).toBe(directory === system ? 1 : 2);
      for (const path of result.matches.items) {
        await expect(readProject(ctx, { path })).resolves.toMatchObject({ data: { content: { content: expect.stringContaining('needle') } } });
      }
      const grep = await grepProject(ctx, { path: directory, pattern: 'needle' }) as Page<Match>;
      expect(grep.matches.items.map((match) => match.path)).toEqual(result.matches.items);
    }
    await expect(readProject(ctx, { path: 'local.txt' })).resolves.toMatchObject({ data: { path: 'local.txt' } });
    await expect(readProject(ctx, { path: 'project:///linked/a.txt' })).rejects.toThrow(/outside the project root/);
    await expect(readProject(ctx, { path: '../sibling/a.txt' })).rejects.toThrow(/traversal/);
    const local = await globProject(ctx, { directory: '.', pattern: '*.txt' }) as Page<string>;
    // Encountered directory symlinks are not followed by recursive discovery.
    expect(local.matches.items).toEqual(['local.txt']);
  });

  it('preserves native punctuation, supported system URL equivalence and strict URL parsing', async () => {
    const { projectRoot, sibling } = fixture();
    const file = join(sibling, 'colon:percent%query?fragment#.md');
    writeFileSync(file, 'punctuation');
    const supported = join(sibling, 'colon:percent%.md');
    writeFileSync(supported, 'punctuation');
    for (const path of [file, supported, systemUrl(supported)]) {
      await expect(readProject({ projectRoot }, { path })).resolves.toMatchObject({ data: { content: { content: 'punctuation' } } });
    }
    const native = await globProject({ projectRoot }, { directory: sibling, pattern: '*.md' }) as Page<string>;
    expect(native.matches.items).toEqual([file, supported].sort());
    for (const path of native.matches.items) {
      await expect(readProject({ projectRoot }, { path })).resolves.toMatchObject({ data: { content: { content: 'punctuation' } } });
    }
    for (const path of ['unknown:///a', 'system://host/a', 'system:///a?b', 'system:///a#b', 'system:///%ZZ']) {
      await expect(readProject({ projectRoot }, { path })).rejects.toThrow();
    }
  });

  it('retains deterministic complete totals and stable-input collection pagination outside the project', async () => {
    const { projectRoot, sibling } = fixture();
    mkdirSync(join(sibling, 'A'));
    writeFileSync(join(sibling, 'A', 'c.txt'), 'needle nested');
    const expected = [join(sibling, 'A/c.txt'), join(sibling, 'a.txt'), join(sibling, 'b.txt')];
    let position: Position | undefined;
    const paths: string[] = [];
    do {
      const page = await globProject({ projectRoot }, { directory: sibling, pattern: '**/*.txt', max_results: 1, position }) as Page<string>;
      expect(page.matches.total).toBe(3);
      paths.push(...page.matches.items);
      position = page.matches.next ?? undefined;
    } while (position);
    expect(paths).toEqual(expected);
    position = undefined;
    const matches: Match[] = [];
    do {
      const page = await grepProject({ projectRoot }, { path: sibling, pattern: 'needle', include: '**/*.txt', max_results: 1, position }) as Page<Match>;
      expect(page.matches.total).toBe(3);
      matches.push(...page.matches.items);
      position = page.matches.next ?? undefined;
    } while (position);
    expect(matches.map((match) => match.path)).toEqual(expected);
  });

  it('keeps native mutation, save authorization, patch and image admission contained', async () => {
    const { projectRoot, sibling } = fixture();
    const path = join(sibling, 'a.txt');
    const ctx = { projectRoot, cardId: 'card-a', agentName: 'executor' as const };
    await expect(writeProject(ctx, { path, content: 'changed' })).rejects.toThrow(/outside the project root/);
    await expect(editProject(ctx, { path, old_string: 'needle', new_string: 'changed' })).rejects.toThrow(/outside the project root/);
    expect(() => authorizeWriteProject(ctx, { path })).toThrow(/outside the project root/);
    for (const source of [path, 'linked/a.txt', systemUrl(path)]) {
      expect(() => readWorkspaceImageSource(ctx, source, 1024)).toThrow(/outside the project root|supports project/);
    }
    await expect(applyProjectPatch(ctx, { patch: `--- ${path}\n+++ ${path}\n@@ -1 +1 @@\n-needle sibling\n+changed\n` })).rejects.toThrow(/Unsafe patch path/);
    expect(readFileSync(path, 'utf8')).toBe('needle sibling');
  });

  it('preserves OS errors, directory/metadata, binary and size bounds, and UTF-8 text continuation externally', async () => {
    const { projectRoot, sibling } = fixture();
    const ctx = { projectRoot };
    for (const path of [join(sibling, 'missing'), systemUrl(join(sibling, 'missing'))]) {
      await expect(readProject(ctx, { path })).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(globProject(ctx, { directory: path, pattern: '*' })).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(grepProject(ctx, { path: join(sibling, 'a.txt/child'), pattern: 'needle' })).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(readProject(ctx, { path: sibling })).resolves.toMatchObject({ data: { is_directory: true, total_entries: 2 } });
    await expect(readProject(ctx, { path: sibling, metadata_only: true })).resolves.toMatchObject({ data: { metadata_only: true, entries_count: 2 } });
    const binary = join(sibling, 'binary');
    writeFileSync(binary, Buffer.alloc(32));
    await expect(readProject(ctx, { path: binary })).rejects.toThrow(/binary/);
    const large = join(sibling, 'large.txt');
    writeFileSync(large, Buffer.alloc(MAX_READ_FILE_BYTES + 1, 'x'));
    await expect(readProject(ctx, { path: large })).resolves.toMatchObject({ data: { too_large: true, content: null } });
    const unicode = join(sibling, 'unicode.txt');
    const text = 'α😀中\n'.repeat(400);
    writeFileSync(unicode, text);
    let byte_offset = 0;
    let reconstructed = '';
    do {
      const { data } = await readProject(ctx, { path: unicode, position: { kind: 'text', byte_offset }, response_bytes: 1024 });
      const result = data as { content: { content: string; next_offset_bytes: number }; total_bytes: number };
      reconstructed += result.content.content;
      expect(result.content.next_offset_bytes).toBeGreaterThan(byte_offset);
      byte_offset = result.content.next_offset_bytes;
    } while (byte_offset < Buffer.byteLength(text));
    expect(reconstructed).toBe(text);
  });
});

describe('workspace read input admission', () => {
  it('accepts only auto and text read modes', () => {
    expect(readWorkspaceInputSchema.parse({ path: 'README.md', read_mode: 'auto' }).read_mode).toBe('auto');
    expect(readWorkspaceInputSchema.parse({ path: 'README.md', read_mode: 'text' }).read_mode).toBe('text');
    expect(readWorkspaceInputSchema.safeParse({ path: 'README.md', read_mode: 'multimodal' }).success).toBe(false);
  });
});

describe('applyProjectPatch path admission', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function gitProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'saivage-patch-path-'));
    roots.push(root);
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
    if (initialized.status !== 0) throw new Error(initialized.stderr || 'Failed to initialize test Git repository.');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'v1..v2.md'), 'before\n', 'utf8');
    return root;
  }

  it('applies a text patch to an adjacent-dot filename', async () => {
    const root = gitProject();
    const patch = [
      'diff --git a/docs/v1..v2.md b/docs/v1..v2.md',
      '--- a/docs/v1..v2.md',
      '+++ b/docs/v1..v2.md',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      '',
    ].join('\n');

    await expect(applyProjectPatch({ projectRoot: root }, { patch })).resolves.toEqual({
      changed_files: ['docs/v1..v2.md'],
      applied: true,
    });
    expect(readFileSync(join(root, 'docs', 'v1..v2.md'), 'utf8')).toBe('after\n');
  });

  it.each([
    ['../x', '../x'],
    ['a/../b', 'a/../b'],
  ])('rejects parent path %s before invoking Git apply', async (headerPath, unsafePath) => {
    const root = gitProject();
    const patch = `--- ${headerPath}\n+++ ${headerPath}\n@@ -0,0 +1 @@\n+unsafe\n`;
    await expect(applyProjectPatch({ projectRoot: root }, { patch })).rejects.toThrow(`Unsafe patch path '${unsafePath}'.`);
  });
});
