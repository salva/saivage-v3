import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProject, writeProject } from '../../src/tools/project-file-tools.js';
import { closeOpenRecordSlot } from '../../src/runtime/records/record-slots.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-project-tools-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

describe('project file tools record enforcement', () => {
  it('returns normalized record urls for allowed record writes and reads', async () => withTempProject(async (projectRoot) => {
    const write = await writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record://status.md?v=next', content: 'planner status' });
    expect(write).toMatchObject({ record_url: 'record://status.md?card=card-1&v=1', written: true });
    closeOpenRecordSlot(projectRoot, { cardId: 'card-1', filename: 'status.md' });

    const read = await readProject({ projectRoot, cardId: 'card-2', agentRole: 'reviewer' }, { path: 'record://status.md?card=card-1' });
    expect(read).toMatchObject({ record_url: 'record://status.md?card=card-1&v=1', content: 'planner status' });
  }));

  it('hard rejects writes outside the role-designated record slot', async () => withTempProject(async (projectRoot) => {
    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'reviewer' }, { path: 'record://status.md?v=next', content: 'bad' })).rejects.toThrow("reviewer cannot write record slot 'status'");
    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'record://status.md?card=card-2&v=next', content: 'bad' })).rejects.toThrow('current card');
  }));

  it('allows executor project writes but rejects planner project writes', async () => withTempProject(async (projectRoot) => {
    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'planner' }, { path: 'project://notes.md', content: 'no' })).rejects.toThrow('planner cannot write project files');
    await expect(writeProject({ projectRoot, cardId: 'card-1', agentRole: 'executor' }, { path: 'project://notes.md', content: 'yes' })).resolves.toMatchObject({ written: true });
    expect(existsSync(join(projectRoot, 'notes.md'))).toBe(true);
  }));
});
