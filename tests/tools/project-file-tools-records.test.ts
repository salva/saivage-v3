import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globProject, grepProject, readProject, writeProject } from '../../src/tools/project-file-tools.js';
import { closeOpenRecordSlot, readClosedRecordSlotMetadata } from '../../src/runtime/records/record-slots.js';
import { initRuntimeState } from '../../src/runtime/state.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-project-tools-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

describe('project file tools record enforcement', () => {
  it('returns normalized record urls for allowed record writes and reads', async () => withTempProject(async (projectRoot) => {
    const write = await writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///status.md?v=next', content: 'planner status' });
    expect(write).toMatchObject({ record_url: 'record:///status.md?card=card-1&v=1', written: true });
    closeOpenRecordSlot(projectRoot, { cardId: 'card-1', filename: 'status.md' });

    const read = await readProject({ projectRoot, cardId: 'card-2', agentRole: 'reviewer' }, { path: 'record:///status.md?card=card-1' });
    expect(read).toMatchObject({ record_url: 'record:///status.md?card=card-1&v=1', content: 'planner status' });
  }));

  it('hard rejects writes outside the role-designated record slot', async () => withTempProject(async (projectRoot) => {
    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'reviewer' }, { path: 'record:///status.md?v=next', content: 'bad' })).rejects.toThrow("reviewer cannot write record slot 'status'");
    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///review.md?v=next', content: 'bad' })).rejects.toThrow("planner cannot write record slot 'review'");
    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///status.md?card=card-2&v=next', content: 'bad' })).rejects.toThrow('current card');
    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///card.json?v=next', content: '{}' })).rejects.toThrow('internal');
  }));

  it('classifies analyst unsupported record slots as workspace tool input errors', async () => withTempProject(async (projectRoot) => {
    initRuntimeState(projectRoot);
    const store = { read: () => ({ id: 'card-1', version_seq: 1, status: 'done' }) as any, getAncestors: () => [], setStatus: () => ({}) as any };

    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'analyst', store, notifyCard: () => ({ ok: true }) }, { path: 'record:///bogus.md?card=card-1&v=next', content: 'bad' })).rejects.toMatchObject({ name: 'WorkspaceToolInputError' });
  }));

  it('classifies analyst malformed record URLs as workspace tool input errors', async () => withTempProject(async (projectRoot) => {
    initRuntimeState(projectRoot);
    const store = { read: () => ({ id: 'card-1', version_seq: 1, status: 'done' }) as any, getAncestors: () => [], setStatus: () => ({}) as any };

    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'analyst', store, notifyCard: () => ({ ok: true }) }, { path: 'record:///brief.md/../x', content: 'bad' })).rejects.toMatchObject({ name: 'WorkspaceToolInputError' });
  }));

  it('exposes metadata for closed record documents without exposing internal card storage', async () => withTempProject(async (projectRoot) => {
    await writeProject({ projectRoot, cardId: 'card-1', agentRole: 'executor' }, { path: 'record:///status.md?v=next', content: 'executor status' });
    closeOpenRecordSlot(projectRoot, { cardId: 'card-1', filename: 'status.md', writer: 'executor', cardVersionSeq: 3 });

    await expect(readProject({ projectRoot, cardId: 'card-1', agentRole: 'executor' }, { path: 'record:///card.json?card=card-1&v=1' })).rejects.toThrow('internal');
    const metadata = readClosedRecordSlotMetadata(projectRoot, { cardId: 'card-1', filename: 'status.md', version: 1 });
    expect(metadata).toMatchObject({ url: 'record:///status.md?card=card-1&v=1', writer: 'executor', size: 15, format: 'markdown', schema: 'record.status.markdown.v1', cardVersionSeq: 3, globalSeq: 1 });
  }));

  it('allows executor project writes but rejects planner project writes', async () => withTempProject(async (projectRoot) => {
    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'project:///notes.md', content: 'no' })).rejects.toThrow('planner cannot write project files');
    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'executor' }, { path: 'project:///notes.md', content: 'yes' })).resolves.toMatchObject({ written: true });
    expect(existsSync(join(projectRoot, 'notes.md'))).toBe(true);
  }));

  it('rejects record search URLs that try to escape the record output tree', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage', 'runtime'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage', 'runtime', 'state.json'), '{"secret":true}');

    await expect(globProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { directory: 'record:///..%2Fruntime', pattern: '**/*' })).rejects.toMatchObject({ name: 'WorkspaceToolInputError' });
    await expect(grepProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///a..b', pattern: 'secret' })).rejects.toMatchObject({ name: 'WorkspaceToolInputError' });
    await expect(globProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { directory: 'record:///card-1/..%2Fruntime', pattern: '**/*' })).rejects.toMatchObject({ name: 'WorkspaceToolInputError' });
  }));

  it('greps the latest closed record versions by card id without redaction', async () => withTempProject(async (projectRoot) => {
    await writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///brief.md?v=next', content: '# Goal\n\nFind the needle.\n' });
    closeOpenRecordSlot(projectRoot, { cardId: 'card-1', filename: 'brief.md', writer: 'planner' });

    const result = await grepProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///card-1', pattern: 'needle' }) as { matches: Array<{ path: string; line: number; preview: string }>; truncated: boolean };

    expect(result).toEqual({ pattern: 'needle', matches: [{ path: 'record:///brief.md?card=card-1&v=1', line: 3, preview: 'Find the needle.' }], truncated: false });
    expect(result.matches[0]!.preview).not.toContain('[REDACTED]');
  }));

  it('returns no grep matches for record cards without closed versions', async () => withTempProject(async (projectRoot) => {
    const result = await grepProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record:///card-1', pattern: 'needle' });

    expect(result).toEqual({ pattern: 'needle', matches: [], truncated: false });
  }));

  it('does not leak directly-addressed hidden scoped files through grep or glob', async () => withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
    mkdirSync(join(projectRoot, '.saivage-work', 'tmp', 'runtime'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), 'HIDDEN_SAIVAGE_TOKEN', 'utf8');
    writeFileSync(join(projectRoot, '.saivage-work', 'tmp', 'runtime', 'runtime.lock'), 'HIDDEN_LOCK_TOKEN', 'utf8');

    const saivageGrep = await grepProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'project:///.saivage/saivage.yaml', pattern: 'HIDDEN_SAIVAGE_TOKEN' });
    const lockGrep = await grepProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'project:///.saivage-work/tmp/runtime/runtime.lock', pattern: 'HIDDEN_LOCK_TOKEN' });
    const saivageGlob = await globProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { directory: 'project:///.saivage/saivage.yaml', pattern: '*' });

    expect(saivageGrep).toEqual({ pattern: 'HIDDEN_SAIVAGE_TOKEN', matches: [], truncated: false });
    expect(lockGrep).toEqual({ pattern: 'HIDDEN_LOCK_TOKEN', matches: [], truncated: false });
    expect(saivageGlob).toEqual({ directory: '.saivage/saivage.yaml', pattern: '*', matches: [], truncated: false });
  }));
});
