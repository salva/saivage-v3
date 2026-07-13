import { CardStore, initProjectTree } from '../helpers/canonical-project.js';
import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globProject, grepProject, readProject, writeProject } from '../../src/tools/project-file-tools.js';

import { initRuntimeState } from '../helpers/runtime-state.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-project-tools-'));
  initProjectTree(projectRoot);
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function recordCtx(projectRoot: string, agentRole: 'planner' | 'reviewer' | 'executor', cardId = 'project') { return { projectRoot, cardId, agentRole, store: new CardStore(projectRoot) }; }

function closeRecord(store: CardStore, cardId: string, filename: string, writer: 'planner' | 'reviewer' | 'executor' = 'planner', cardVersionSeq = 1): void {
  const open = store.readRecord(cardId, filename, 'open');
  store.closeRecord(cardId, filename, open.version, writer, cardVersionSeq);
}

describe('project file tools record enforcement', () => {
  it('returns normalized record urls for allowed record writes and reads', async () => withTempProject(async (projectRoot) => {
    const ctx = recordCtx(projectRoot, 'planner');
    const write = await writeProject(ctx, { path: 'record:///status.md?v=next', content: 'planner status' });
    expect(write).toMatchObject({ record_url: 'record:///status.md?card=project&v=1', written: true });
    closeRecord(ctx.store, 'project', 'status.md');

    const read = await readProject(recordCtx(projectRoot, 'reviewer'), { path: 'record:///status.md?card=project' });
    expect(read).toMatchObject({ record_url: 'record:///status.md?card=project&v=1', content: 'planner status' });
  }));

  it('hard rejects writes outside the role-designated record slot', async () => withTempProject(async (projectRoot) => {
    await expect(writeProject(recordCtx(projectRoot, 'reviewer'), { path: 'record:///status.md?v=next', content: 'bad' })).rejects.toThrow("reviewer cannot write record slot 'status'");
    await expect(writeProject(recordCtx(projectRoot, 'planner'), { path: 'record:///review.md?v=next', content: 'bad' })).rejects.toThrow("planner cannot write record slot 'review'");
    await expect(writeProject(recordCtx(projectRoot, 'planner'), { path: 'record:///status.md?card=other&v=next', content: 'bad' })).rejects.toThrow('current card');
    await expect(writeProject(recordCtx(projectRoot, 'planner'), { path: 'record:///card.json?v=next', content: '{}' })).rejects.toThrow('internal');
  }));

  it('classifies analyst unsupported record slots as workspace tool input errors', async () => withTempProject(async (projectRoot) => {
    initRuntimeState(projectRoot);
    const store = { read: () => ({ id: 'card-1', version_seq: 1, status: 'done' }) as any, getAncestors: () => [], setStatus: () => ({}) as any };

    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'analyst', store: store as any, notifyCard: () => ({ ok: true }) }, { path: 'record:///bogus.md?card=card-1&v=next', content: 'bad' })).rejects.toMatchObject({ name: 'WorkspaceToolInputError' });
  }));

  it('classifies analyst malformed record URLs as workspace tool input errors', async () => withTempProject(async (projectRoot) => {
    initRuntimeState(projectRoot);
    const store = { read: () => ({ id: 'card-1', version_seq: 1, status: 'done' }) as any, getAncestors: () => [], setStatus: () => ({}) as any };

    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'analyst', store: store as any, notifyCard: () => ({ ok: true }) }, { path: 'record:///brief.md/../x', content: 'bad' })).rejects.toMatchObject({ name: 'WorkspaceToolInputError' });
  }));

  it('exposes metadata for closed record documents without exposing internal card storage', async () => withTempProject(async (projectRoot) => {
    const ctx = recordCtx(projectRoot, 'executor');
    await writeProject(ctx, { path: 'record:///status.md?v=next', content: 'executor status' });
    closeRecord(ctx.store, 'project', 'status.md', 'executor');

    await expect(readProject(recordCtx(projectRoot, 'executor'), { path: 'record:///card.json?card=project&v=1' })).rejects.toThrow('internal');
    const metadata = ctx.store.readRecord('project', 'status.md', 1);
    expect(metadata).toMatchObject({ recordUrl: 'record:///status.md?card=project&v=1', artifact: { writer: 'executor', content: 'executor status', format: 'markdown', schema: 'record.status.markdown.v1', card_version_seq: 1 } });
  }));

  it('allows executor project writes but rejects planner project writes', async () => withTempProject(async (projectRoot) => {
    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'project:///notes.md', content: 'no' })).rejects.toThrow('planner cannot write project files');
    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'executor' }, { path: 'project:///notes.md', content: 'yes' })).resolves.toMatchObject({ written: true });
    expect(existsSync(join(projectRoot, 'notes.md'))).toBe(true);
  }));

  it('rejects record search URLs that try to escape the record output tree', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage', 'runtime'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage', 'runtime', 'errors.jsonl'), '{"secret":true}\n');

    await expect(globProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { directory: 'record:///..%2Fruntime', pattern: '**/*' })).rejects.toMatchObject({ name: 'WorkspaceToolInputError' });
    await expect(grepProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///a..b', pattern: 'secret' })).rejects.toMatchObject({ name: 'WorkspaceToolInputError' });
    await expect(globProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { directory: 'record:///card-1/..%2Fruntime', pattern: '**/*' })).rejects.toMatchObject({ name: 'WorkspaceToolInputError' });
  }));

  it('greps the latest closed record versions by card id without redaction', async () => withTempProject(async (projectRoot) => {
    const ctx = recordCtx(projectRoot, 'planner');
    await writeProject(ctx, { path: 'record:///brief.md?v=next', content: '# Goal\n\nFind the needle.\n' });
    closeRecord(ctx.store, 'project', 'brief.md');

    const result = await grepProject(recordCtx(projectRoot, 'planner'), { path: 'record:///project', pattern: 'needle' }) as { matches: Array<{ path: string; line: number; preview: string }>; truncated: boolean };

    expect(result).toEqual({ pattern: 'needle', matches: [{ path: 'record:///brief.md?card=project&v=2', line: 3, preview: 'Find the needle.' }], truncated: false });
    expect(result.matches[0]!.preview).not.toContain('[REDACTED]');
  }));

  it('returns no grep matches for record cards without closed versions', async () => withTempProject(async (projectRoot) => {
    const result = await grepProject(recordCtx(projectRoot, 'planner'), { path: 'record:///project', pattern: 'needle' });

    expect(result).toEqual({ pattern: 'needle', matches: [], truncated: false });
  }));

  it('does not leak directly-addressed hidden scoped files through grep or glob', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
    mkdirSync(join(projectRoot, '.saivage', 'locks'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), 'HIDDEN_SAIVAGE_TOKEN', 'utf8');
    writeFileSync(join(projectRoot, '.saivage', 'locks', 'runtime.lock'), 'HIDDEN_LOCK_TOKEN', 'utf8');

    const saivageGrep = await grepProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'project:///.saivage/saivage.yaml', pattern: 'HIDDEN_SAIVAGE_TOKEN' });
    const lockGrep = await grepProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'project:///.saivage/locks/runtime.lock', pattern: 'HIDDEN_LOCK_TOKEN' });
    const saivageGlob = await globProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { directory: 'project:///.saivage/saivage.yaml', pattern: '*' });

    expect(saivageGrep).toEqual({ pattern: 'HIDDEN_SAIVAGE_TOKEN', matches: [], truncated: false });
    expect(lockGrep).toEqual({ pattern: 'HIDDEN_LOCK_TOKEN', matches: [], truncated: false });
    expect(saivageGlob).toEqual({ directory: '.saivage/saivage.yaml', pattern: '*', matches: [], truncated: false });
  }));
});
