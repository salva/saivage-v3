import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, relative, resolve, sep } from 'node:path';

import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { listScopedPath, visitFiles, visitScopedFiles } from '../../src/workspace/vfs.js';
import { authorizeWriteProject, editProject, readProject, writeProject } from '../../src/tools/project-file-tools.js';
import { buildScopedPathUrl } from '../../src/contracts/scoped-path-url.js';
import { cardNamespace } from '../../src/persistence/layout.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function fail(message: string): Error { return new Error(message); }
function systemUrl(absolutePath: string): string {
  const normalized = resolve(absolutePath);
  return buildScopedPathUrl('system', relative(parse(normalized).root, normalized).split(sep).filter(Boolean));
}

describe('workspace VFS and project-file security', () => {
  it('visits filesystem scopes depth-first by explicit string order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-order-'));
    roots.push(root);
    initProjectTree(root);
    const ordinary = join(root, 'ordered');
    mkdirSync(join(ordinary, 'b-dir'), { recursive: true });
    mkdirSync(join(ordinary, 'A-dir'), { recursive: true });
    writeFileSync(join(ordinary, 'z.txt'), 'z');
    writeFileSync(join(ordinary, 'b-dir', 'b.txt'), 'b');
    writeFileSync(join(ordinary, 'A-dir', 'a.txt'), 'a');

    const direct: string[] = [];
    await visitFiles(root, ordinary, async (_absolutePath, displayPath) => { direct.push(displayPath); }, { includeHidden: false });
    expect(direct).toEqual(['ordered/A-dir/a.txt', 'ordered/b-dir/b.txt', 'ordered/z.txt']);

    const fixtures = [
      ['project:///ordered', ['ordered/A-dir/a.txt', 'ordered/b-dir/b.txt', 'ordered/z.txt']],
      ['tmp:///card-a/ordered', ['.saivage/work/cards/card-a/tmp/ordered/A-dir/a.txt', '.saivage/work/cards/card-a/tmp/ordered/b-dir/b.txt', '.saivage/work/cards/card-a/tmp/ordered/z.txt']],
      ['work:///tmp/ordered', ['work:///tmp/ordered/A-dir/a.txt', 'work:///tmp/ordered/b-dir/b.txt', 'work:///tmp/ordered/z.txt']],
    ] as const;
    for (const [url] of fixtures.slice(1)) {
      const destination = url.startsWith('tmp:///')
        ? join(root, '.saivage/work/cards/card-a/tmp/ordered')
        : join(root, '.saivage/work/tmp/ordered');
      mkdirSync(join(destination, 'b-dir'), { recursive: true });
      mkdirSync(join(destination, 'A-dir'), { recursive: true });
      writeFileSync(join(destination, 'z.txt'), 'z');
      writeFileSync(join(destination, 'b-dir', 'b.txt'), 'b');
      writeFileSync(join(destination, 'A-dir', 'a.txt'), 'a');
    }
    for (const [url, expected] of fixtures) {
      const visited: string[] = [];
      await visitScopedFiles({ projectRoot: root, agent: { cardId: 'card-a', agentName: 'executor' }, fail }, url, async ({ displayPath }) => { visited.push(displayPath); });
      expect(visited).toEqual(expected);
    }

    const systemVisited: string[] = [];
    await visitScopedFiles({ projectRoot: root, fail }, systemUrl(ordinary), async ({ displayPath }) => { systemVisited.push(displayPath); });
    expect(systemVisited).toEqual([
      systemUrl(join(ordinary, 'A-dir', 'a.txt')),
      systemUrl(join(ordinary, 'b-dir', 'b.txt')),
      systemUrl(join(ordinary, 'z.txt')),
    ]);
  });

  it('visits only effective declared records in explicit filename order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-record-order-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'goal', parent: 'project', title: 'Record order', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.openRecord(child.id, 'status.md');
    cards.editRecord(child.id, 'status.md', 'status');
    cards.openRecord(child.id, 'review.md');
    cards.editRecord(child.id, 'review.md', 'review');
    writeFileSync(join(cardNamespace(root, child.id), 'record-undiscoverable-orphan.jsonl'), 'needle orphan');

    const visited: string[] = [];
    await visitScopedFiles({ projectRoot: root, records: cards, fail }, `record:///${child.id}`, async ({ displayPath }) => { visited.push(displayPath); });
    expect(visited).toEqual(['brief.md', 'review.md', 'status.md'].map((name) => `record:///${name}?card=${encodeURIComponent(child.id)}`));
    expect(visited.join('\n')).not.toContain('undiscoverable-orphan');
  });

  it('filters internal, dependency, and secret paths from listing, globbing, and visiting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-security-'));
    roots.push(root);
    initProjectTree(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'docs', 'SPEC.md'), 'visible');
    writeFileSync(join(root, '.env'), 'SECRET=hidden');
    writeFileSync(join(root, 'node_modules', 'pkg', 'hidden.md'), 'hidden');
    const visited: string[] = [];
    await visitScopedFiles({ projectRoot: root, fail }, 'project:///', async ({ displayPath }) => { visited.push(displayPath); });
    expect(await listScopedPath({ projectRoot: root, fail }, 'project:///')).toEqual({ kind: 'entries', entries: [{ name: 'docs', type: 'dir' }] });
    expect(visited).toEqual(['docs/SPEC.md']);
  });

  it('rejects traversal, internal-state writes, secret reads, and symlink writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-security-'));
    roots.push(root);
    initProjectTree(root);
    writeFileSync(join(root, '.env'), 'SECRET=hidden');
    writeFileSync(join(root, 'target.txt'), 'safe');
    symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'));
    await expect(readProject({ projectRoot: root }, { path: '../outside' })).rejects.toThrow(/inside the project root|escapes|traversal/);
    await expect(readProject({ projectRoot: root }, { path: '.env' })).rejects.toThrow(/blocked for security/);
    await expect(writeProject({ projectRoot: root, agentName: 'executor' }, { path: '.saivage/state.json', content: 'x' })).rejects.toThrow(/internal state/);
    await expect(writeProject({ projectRoot: root, agentName: 'executor' }, { path: 'project:///.saivage/state.json', content: 'x' })).rejects.toThrow(/internal state/);
    await expect(writeProject({ projectRoot: root, agentName: 'executor' }, { path: 'link.txt', content: 'x' })).rejects.toThrow(/symlink/);
  });

  it('classifies protected scoped writes by destination while retaining only tmp capability', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-security-'));
    roots.push(root);
    initProjectTree(root);
    const ctx = { projectRoot: root, agentName: 'executor' as const, cardId: 'card-a' };
    const internalRoot = resolve(root, '.saivage');
    const internalFile = resolve(internalRoot, 'state.json');
    writeFileSync(internalFile, 'retained-state');

    await expect(writeProject(ctx, { path: systemUrl(internalRoot), content: 'replacement' })).rejects.toThrow(/internal state/);
    await expect(writeProject(ctx, { path: systemUrl(internalFile), content: 'replacement' })).rejects.toThrow(/internal state/);
    await expect(editProject(ctx, { path: systemUrl(internalFile), old_string: 'retained', new_string: 'replaced' })).rejects.toThrow(/internal state/);
    expect(readFileSync(internalFile, 'utf8')).toBe('retained-state');
    expect(() => authorizeWriteProject(ctx, { path: systemUrl(internalFile) })).toThrow(/internal state/);

    const siblingFile = resolve(root, '.saivage-other', 'file.txt');
    await expect(writeProject(ctx, { path: systemUrl(siblingFile), content: 'sibling-content' })).resolves.toMatchObject({ kind: 'applied', data: { destination_kind: 'system_url', target: systemUrl(siblingFile), written: true } });
    expect(readFileSync(siblingFile, 'utf8')).toBe('sibling-content');

    const tmpFile = resolve(root, '.saivage', 'work', 'cards', 'card-a', 'tmp', 'scratch.txt');
    await expect(writeProject(ctx, { path: 'tmp:///card-a/scratch.txt', content: 'tmp-content' })).resolves.toMatchObject({ kind: 'applied', data: { destination_kind: 'tmp_url', target: 'tmp:///card-a/scratch.txt', written: true } });
    expect(readFileSync(tmpFile, 'utf8')).toBe('tmp-content');
    await expect(writeProject(ctx, { path: systemUrl(tmpFile), content: 'replacement' })).rejects.toThrow(/internal state/);
    expect(readFileSync(tmpFile, 'utf8')).toBe('tmp-content');
  });

  it('redacts outbound work-file content while preserving ordinary project source text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-security-'));
    roots.push(root);
    initProjectTree(root);
    mkdirSync(join(root, '.saivage', 'work', 'processes'), { recursive: true });
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    writeFileSync(join(root, '.saivage', 'work', 'processes', 'run.log'), `token=${secret}`);
    writeFileSync(join(root, 'example.txt'), `documentation=${secret}`);
    const work = await readProject({ projectRoot: root }, { path: 'work:///processes/run.log' }) as { content: { content: string } };
    const project = await readProject({ projectRoot: root }, { path: 'example.txt' }) as { content: { content: string } };
    expect(work.content.content).not.toContain(secret);
    expect(work.content.content).toContain('[REDACTED]');
    expect(project.content.content).toContain(secret);
  });
});
