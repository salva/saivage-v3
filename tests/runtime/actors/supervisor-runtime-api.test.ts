import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { createSupervisorRuntimeApi, readActorSnapshots } from '../../../src/runtime/actors/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-api-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

describe('SupervisorRuntimeApi', () => {
  it('implements start, pause, resume, status, and shutdown through RuntimeSupervisor', async () => withTempProject(async (projectRoot) => {
    const api = createSupervisorRuntimeApi({ projectRoot, now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();
    expect(api.getStatus()).toMatchObject({ status: 'idle', paused: false, currentCardId: null });
    api.pause();
    expect(api.getStatus()).toMatchObject({ status: 'paused', paused: true });
    api.resume();
    expect(api.getStatus()).toMatchObject({ status: 'idle', paused: false });
    await api.shutdown();

    expect(readActorSnapshots(projectRoot).some((item) => item.actor_id === 'supervisor')).toBe(true);
  }));

  it('fails startProject clearly until goal execution is wired', async () => withTempProject(async (projectRoot) => {
    const api = createSupervisorRuntimeApi({ projectRoot, now: () => '2026-06-12T00:00:00.000Z' });
    await api.start();

    const result = await api.startProject('operator');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.command.status).toBe('rejected');
      expect(result.error.code).toBe('xstate_runtime_not_wired');
    }
  }));
});
