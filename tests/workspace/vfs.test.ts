import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeOpenRecordSlot } from '../../src/runtime/records/record-slots.js';
import { writeProject } from '../../src/tools/project-file-tools.js';
import { globScopedPath, listScopedPath, resolveScopedPath } from '../../src/workspace/vfs.js';

class TestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestInputError';
  }
}

function fail(message: string): Error {
  return new TestInputError(message);
}

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-vfs-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

describe('workspace VFS', () => {
  it('returns null only for non-scoped paths', () => withTempProject((projectRoot) => {
    expect(resolveScopedPath({ projectRoot, fail }, 'src/index.ts', 'read')).toBeNull();
  }));

  it('resolves project, work, and system roots but not tmp or record roots', () => withTempProject((projectRoot) => {
    expect(resolveScopedPath({ projectRoot, fail }, 'project:///', 'read')).toMatchObject({ kind: 'project', absolutePath: projectRoot, relativePath: '.', isRoot: true });
    expect(resolveScopedPath({ projectRoot, fail }, 'work:///', 'read')).toMatchObject({ kind: 'work', absolutePath: join(projectRoot, '.saivage-work'), relativePath: '.saivage-work', isRoot: true });
    expect(resolveScopedPath({ projectRoot, fail }, 'system:///', 'read')).toMatchObject({ kind: 'system', absolutePath: '/', relativePath: 'system:///', isRoot: true });
    expect(() => resolveScopedPath({ projectRoot, agent: { cardId: 'card-1', agentRole: 'executor' }, fail }, 'tmp:///', 'read')).toThrow(TestInputError);
    expect(() => resolveScopedPath({ projectRoot, agent: { cardId: 'card-1', agentRole: 'executor' }, fail }, 'record:///', 'read')).toThrow(TestInputError);
  }));

  it('lists and globs project roots through filtered filesystem entries', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    writeFileSync(join(projectRoot, 'docs', 'SPEC.md'), 'spec', 'utf8');

    const listing = await listScopedPath({ projectRoot, fail }, 'project:///');
    const glob = await globScopedPath({ projectRoot, fail }, 'project:///', '**/*.md', 20);

    expect(listing).toEqual({ kind: 'entries', entries: [{ name: 'docs', type: 'dir' }] });
    expect(glob.matches).toEqual(['docs/SPEC.md']);
  }));

  it('keeps record document and card-id namespaces distinct', async () => withTempProject(async (projectRoot) => {
    await writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///brief.md?v=next', content: 'brief one' });
    closeOpenRecordSlot(projectRoot, { cardId: 'card-1', filename: 'brief.md', writer: 'planner', cardVersionSeq: 1 });

    const document = resolveScopedPath({ projectRoot, agent: { cardId: 'card-1', agentRole: 'planner' }, fail }, 'record:///brief.md?card=card-1&v=1', 'read');
    const directory = resolveScopedPath({ projectRoot, agent: { cardId: 'card-1', agentRole: 'planner' }, fail }, 'record:///card-1', 'read');
    const listing = await listScopedPath({ projectRoot, agent: { cardId: 'card-1', agentRole: 'planner' }, fail }, 'record:///card-1');
    const glob = await globScopedPath({ projectRoot, agent: { cardId: 'card-1', agentRole: 'planner' }, fail }, 'record:///card-1', 'brief.*', 20);

    expect(document).toMatchObject({ kind: 'record', recordKind: 'document', recordUrl: 'record:///brief.md?card=card-1&v=1' });
    expect(directory).toMatchObject({ kind: 'record', recordKind: 'directory', cardId: 'card-1' });
    expect(listing).toMatchObject({ kind: 'records', records: expect.arrayContaining([expect.objectContaining({ filename: 'brief.md', url: 'record:///brief.md?card=card-1&v=1', latest: 1 })]) });
    expect(JSON.stringify(listing)).not.toContain('card.json');
    expect(JSON.stringify(listing)).not.toContain('index.json');
    expect(glob).toEqual({ matches: ['record:///brief.md?card=card-1&v=1'], truncated: false });
    await expect(listScopedPath({ projectRoot, agent: { cardId: 'card-1', agentRole: 'planner' }, fail }, 'record:///card-1/brief.md')).rejects.toThrow(TestInputError);
  }));
});
