import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, relative, resolve, sep } from 'node:path';

import { initProjectTree } from '../helpers/canonical-project.js';
import { globScopedPath, listScopedPath, visitScopedFiles } from '../../src/workspace/vfs.js';
import { authorizeWriteProject, editProject, readProject, writeProject } from '../../src/tools/project-file-tools.js';
import { buildScopedPathUrl } from '../../src/contracts/scoped-path-url.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function fail(message: string): Error { return new Error(message); }
function systemUrl(absolutePath: string): string {
  const normalized = resolve(absolutePath);
  return buildScopedPathUrl('system', relative(parse(normalized).root, normalized).split(sep).filter(Boolean));
}

describe('workspace VFS and project-file security', () => {
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
    expect(await globScopedPath({ projectRoot: root, fail }, 'project:///', '**/*.md', 20)).toEqual({ matches: ['docs/SPEC.md'], truncated: false });
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
    await expect(writeProject({ projectRoot: root, agentRole: 'executor' }, { path: '.saivage/state.json', content: 'x' })).rejects.toThrow(/internal state/);
    await expect(writeProject({ projectRoot: root, agentRole: 'executor' }, { path: 'project:///.saivage/state.json', content: 'x' })).rejects.toThrow(/internal state/);
    await expect(writeProject({ projectRoot: root, agentRole: 'executor' }, { path: 'link.txt', content: 'x' })).rejects.toThrow(/symlink/);
    await expect(writeProject({ projectRoot: root, agentRole: 'reviewer' }, { path: 'reviewer-write.txt', content: 'x' })).rejects.toThrow(/reviewer cannot write project files/);
  });

  it('classifies protected scoped writes by destination while retaining only tmp capability', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-security-'));
    roots.push(root);
    initProjectTree(root);
    const ctx = { projectRoot: root, agentRole: 'executor' as const, cardId: 'card-a' };
    const internalRoot = resolve(root, '.saivage');
    const internalFile = resolve(internalRoot, 'state.json');
    writeFileSync(internalFile, 'retained-state');

    await expect(writeProject(ctx, { path: systemUrl(internalRoot), content: 'replacement' })).rejects.toThrow(/internal state/);
    await expect(writeProject(ctx, { path: systemUrl(internalFile), content: 'replacement' })).rejects.toThrow(/internal state/);
    await expect(editProject(ctx, { path: systemUrl(internalFile), old_string: 'retained', new_string: 'replaced' })).rejects.toThrow(/internal state/);
    expect(readFileSync(internalFile, 'utf8')).toBe('retained-state');
    expect(() => authorizeWriteProject(ctx, { path: systemUrl(internalFile) })).toThrow(/internal state/);

    const siblingFile = resolve(root, '.saivage-other', 'file.txt');
    await expect(writeProject(ctx, { path: systemUrl(siblingFile), content: 'sibling-content' })).resolves.toEqual(expect.objectContaining({ written: true }));
    expect(readFileSync(siblingFile, 'utf8')).toBe('sibling-content');

    const tmpFile = resolve(root, '.saivage', 'work', 'cards', 'card-a', 'tmp', 'scratch.txt');
    await expect(writeProject(ctx, { path: 'tmp:///card-a/scratch.txt', content: 'tmp-content' })).resolves.toEqual(expect.objectContaining({ written: true }));
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
    const work = await readProject({ projectRoot: root }, { path: 'work:///processes/run.log' }) as { content: string };
    const project = await readProject({ projectRoot: root }, { path: 'example.txt' }) as { content: string };
    expect(work.content).not.toContain(secret);
    expect(work.content).toContain('[REDACTED]');
    expect(project.content).toContain(secret);
  });
});
