import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initProjectTree } from '../helpers/canonical-project.js';
import { globScopedPath, listScopedPath, visitScopedFiles } from '../../src/workspace/vfs.js';
import { readProject, writeProject } from '../../src/tools/project-file-tools.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function fail(message: string): Error { return new Error(message); }

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
    await expect(writeProject({ projectRoot: root, agentRole: 'executor' }, { path: 'link.txt', content: 'x' })).rejects.toThrow(/symlink/);
    await expect(writeProject({ projectRoot: root, agentRole: 'reviewer' }, { path: 'reviewer-write.txt', content: 'x' })).rejects.toThrow(/reviewer cannot write project files/);
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
