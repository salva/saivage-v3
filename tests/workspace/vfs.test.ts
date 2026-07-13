import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeOpenRecordSlot } from '../../src/runtime/records/record-slots.js';
import { writeProject } from '../../src/tools/project-file-tools.js';
import { globScopedPath, listScopedPath, resolveScopedPath, visitScopedFiles, walkFiles, type ScopedFileEntry } from '../../src/workspace/vfs.js';

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

async function collect(projectRoot: string, raw: string): Promise<ScopedFileEntry[]> {
  const entries: ScopedFileEntry[] = [];
  await visitScopedFiles({ projectRoot, fail }, raw, async (entry) => {
    entries.push(entry);
  });
  return entries;
}

function systemUrl(absolutePath: string): string {
  return `system:///${absolutePath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

describe('workspace VFS', () => {
  it('returns null only for non-scoped paths', () => withTempProject((projectRoot) => {
    expect(resolveScopedPath({ projectRoot, fail }, 'src/index.ts', 'read')).toBeNull();
  }));

  it('resolves project, work, and system roots but not tmp or record roots', () => withTempProject((projectRoot) => {
    expect(resolveScopedPath({ projectRoot, fail }, 'project:///', 'read')).toMatchObject({ kind: 'project', absolutePath: projectRoot, relativePath: '.', isRoot: true });
    expect(resolveScopedPath({ projectRoot, fail }, 'work:///', 'read')).toMatchObject({ kind: 'work', absolutePath: join(projectRoot, '.saivage/work'), relativePath: '.saivage/work', isRoot: true });
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

  it('visits scoped files for project directories with display and match paths', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
    mkdirSync(join(projectRoot, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage', 'hidden.md'), 'hidden', 'utf8');
    writeFileSync(join(projectRoot, 'node_modules', 'pkg', 'hidden.md'), 'hidden', 'utf8');
    writeFileSync(join(projectRoot, 'docs', 'SPEC.md'), 'spec', 'utf8');

    await expect(collect(projectRoot, 'project:///')).resolves.toEqual([{ absolutePath: join(projectRoot, 'docs', 'SPEC.md'), displayPath: 'docs/SPEC.md', matchPath: 'docs/SPEC.md' }]);
    await expect(collect(projectRoot, 'project:///docs')).resolves.toEqual([{ absolutePath: join(projectRoot, 'docs', 'SPEC.md'), displayPath: 'docs/SPEC.md', matchPath: 'SPEC.md' }]);
  }));

  it('visits work and system paths using URL display paths', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage/work', 'processes'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage/work', 'processes', 'run.log'), 'log', 'utf8');

    const systemRoot = mkdtempSync(join(tmpdir(), 'saivage-vfs-system-'));
    try {
      writeFileSync(join(systemRoot, 'host.txt'), 'host', 'utf8');

      await expect(collect(projectRoot, 'work:///processes')).resolves.toEqual([{ absolutePath: join(projectRoot, '.saivage/work', 'processes', 'run.log'), displayPath: 'work:///processes/run.log', matchPath: 'run.log' }]);
      await expect(collect(projectRoot, systemUrl(systemRoot))).resolves.toEqual([{ absolutePath: join(systemRoot, 'host.txt'), displayPath: `${systemUrl(systemRoot)}/host.txt`, matchPath: 'host.txt' }]);
    } finally {
      rmSync(systemRoot, { recursive: true, force: true });
    }
  }));

  it('visits scoped single files while filtering hidden and secret single-file paths', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
    mkdirSync(join(projectRoot, '.saivage', 'locks'), { recursive: true });
    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    writeFileSync(join(projectRoot, 'docs', 'SPEC.md'), 'spec', 'utf8');
    writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), 'hidden', 'utf8');
    writeFileSync(join(projectRoot, '.saivage', 'locks', 'runtime.lock'), 'hidden', 'utf8');
    writeFileSync(join(projectRoot, '.env'), 'secret', 'utf8');

    await expect(collect(projectRoot, 'project:///docs/SPEC.md')).resolves.toEqual([{ absolutePath: join(projectRoot, 'docs', 'SPEC.md'), displayPath: 'docs/SPEC.md', matchPath: 'docs/SPEC.md' }]);
    await expect(collect(projectRoot, 'project:///.saivage/saivage.yaml')).resolves.toEqual([]);
    await expect(collect(projectRoot, 'project:///.saivage/locks/runtime.lock')).resolves.toEqual([]);
    await expect(collect(projectRoot, 'project:///.env')).resolves.toEqual([]);
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

  it('collects only latest closed exposed record slots', async () => withTempProject(async (projectRoot) => {
    await writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///brief.md?v=next', content: 'brief one' });
    closeOpenRecordSlot(projectRoot, { cardId: 'card-1', filename: 'brief.md', writer: 'planner', cardVersionSeq: 1 });
    await writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///brief.md?v=next', content: 'brief two open' });

    const entries = await collect(projectRoot, 'record:///card-1');

    expect(entries).toEqual([{ absolutePath: join(projectRoot, '.saivage', 'cards', 'card-1', 'brief', '1.md'), displayPath: 'record:///brief.md?card=card-1&v=1', matchPath: 'brief.md' }]);
    expect(JSON.stringify(entries)).not.toContain('card.json');
    expect(JSON.stringify(entries)).not.toContain('2.md');
  }));

  it('does not apply project hidden-path filtering to logical record entries', async () => withTempProject(async (projectRoot) => {
    await writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///brief.md?v=next', content: 'brief one' });
    closeOpenRecordSlot(projectRoot, { cardId: 'card-1', filename: 'brief.md', writer: 'planner', cardVersionSeq: 1 });

    await expect(collect(projectRoot, 'record:///card-1')).resolves.toHaveLength(1);
  }));

  it('short-circuits visitScopedFiles when the awaited visitor returns false', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    writeFileSync(join(projectRoot, 'docs', 'one.md'), 'one', 'utf8');
    writeFileSync(join(projectRoot, 'docs', 'two.md'), 'two', 'utf8');
    let calls = 0;

    await visitScopedFiles({ projectRoot, fail }, 'project:///', async () => {
      calls += 1;
      return false;
    });

    expect(calls).toBe(1);
  }));

  it('rejects non-scoped visitScopedFiles input', async () => withTempProject(async (projectRoot) => {
    await expect(visitScopedFiles({ projectRoot, fail }, '.', async () => undefined)).rejects.toThrow(TestInputError);
  }));

  it('propagates recursive walkFiles short-circuiting across sibling directories', () => withTempProject((projectRoot) => {
    mkdirSync(join(projectRoot, 'a-parent', 'nested'), { recursive: true });
    mkdirSync(join(projectRoot, 'z-sibling'), { recursive: true });
    writeFileSync(join(projectRoot, 'a-parent', 'nested', 'stop.txt'), 'stop', 'utf8');
    writeFileSync(join(projectRoot, 'z-sibling', 'after.txt'), 'after', 'utf8');
    const visited: string[] = [];

    walkFiles(projectRoot, projectRoot, (_absolutePath, relativePath) => {
      visited.push(relativePath);
      return false;
    }, { includeHidden: false });

    expect(visited).toEqual(['a-parent/nested/stop.txt']);
  }));
});
