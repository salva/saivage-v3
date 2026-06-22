import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { createSupervisorRuntimeApi, readActorSnapshots, saveActorSnapshot, SupervisorRuntimeApi } from '../../../src/runtime/actors/index.js';
import { actorToolCallStatusesPath, appendToolCallStatus } from '../../../src/runtime/actors/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-api-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('SupervisorRuntimeApi', () => {
  it('implements start, pause, resume, status, and shutdown through RuntimeSupervisorActor', async () => withTempProject(async (projectRoot) => {
    const api = createSupervisorRuntimeApi({ projectRoot, now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();
    expect(api.getStatus()).toMatchObject({ status: 'idle', paused: false, currentCardId: null });
    api.pause();
    expect(api.getStatus()).toMatchObject({ status: 'idle', paused: false });

    await api.startProject('operator');
    expect(api.getStatus()).toMatchObject({ status: 'running', paused: false, currentCardId: 'project' });
    api.pause();
    expect(api.getStatus()).toMatchObject({ status: 'paused', paused: true, currentCardId: 'project' });
    api.resume();
    expect(api.getStatus()).toMatchObject({ status: 'running', paused: false, currentCardId: 'project' });
    await api.shutdown();

    expect(readActorSnapshots(projectRoot).some((item) => item.actor_id === 'supervisor')).toBe(true);
  }));

  it('captures the actor recovery plan before starting the supervisor', async () => withTempProject(async (projectRoot) => {
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:G-recover',
      actor_kind: 'card',
      state_value: 'planning',
      context: { cardId: 'G-recover', publicStatus: 'running' },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'planner:G-recover',
      actor_kind: 'llm',
      state_value: 'running',
      context: { cardId: 'G-recover' },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    const api = new SupervisorRuntimeApi({ projectRoot, now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(api.getRecoveryPlan()).toMatchObject({
      cards: [{ cardId: 'G-recover', active: true }],
      llms: [{ actorId: 'planner:G-recover', active: true }],
    });
  }));

  it('abandons stale pending tool calls during startup recovery', async () => withTempProject(async (projectRoot) => {
    appendToolCallStatus(projectRoot, {
      agent_id: 'planner:G-stale',
      source_input_id: 'input:G-stale',
      tool_call_id: 'call-stale',
      tool_name: 'activate_card',
      status: 'pending',
    });
    appendToolCallStatus(projectRoot, {
      agent_id: 'planner:G-delivered',
      source_input_id: 'input:G-delivered',
      tool_call_id: 'call-delivered',
      tool_name: 'activate_card',
      status: 'pending',
    });
    appendToolCallStatus(projectRoot, {
      agent_id: 'planner:G-delivered',
      source_input_id: 'input:G-delivered',
      tool_call_id: 'call-delivered',
      tool_name: 'activate_card',
      status: 'delivered',
      delivery_input_id: 'input:G-delivered:child:1',
    });
    const api = new SupervisorRuntimeApi({ projectRoot, now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(readJsonl(actorToolCallStatusesPath(projectRoot, 'planner:G-stale')).map((entry) => entry.status)).toEqual(['pending', 'abandoned']);
    expect(readJsonl(actorToolCallStatusesPath(projectRoot, 'planner:G-delivered')).map((entry) => entry.status)).toEqual(['pending', 'delivered']);
  }));

  it('starts project work at the runtime boundary without invoking lower-level workflow', async () => withTempProject(async (projectRoot) => {
    const api = createSupervisorRuntimeApi({
      projectRoot,
      rootCards: { read: () => ({ id: 'project', type: 'project' }) },
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.command).toMatchObject({ command: 'start_project', status: 'completed', command_id: 'runtime-command-1' });
      expect(result.intent).toEqual({ status: 'running', updated_at: '2026-06-12T00:00:00.000Z', source_command_id: 'runtime-command-1', reason: null });
      expect(result.run).toMatchObject({ run_id: 'runtime-run-1', card_id: 'project', phase: 'pending', runtime_status: 'running' });
    }
  }));

  it('rejects startProject when the project card is missing', async () => withTempProject(async (projectRoot) => {
    const api = createSupervisorRuntimeApi({
      projectRoot,
      rootCards: { read: () => null },
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('runtime_project_card_missing');
  }));

  it('stopProject cancels the active project run and returns a stopped intent', async () => withTempProject(async (projectRoot) => {
    const api = createSupervisorRuntimeApi({
      projectRoot,
      rootCards: { read: () => ({ id: 'project', type: 'project' }) },
      now: () => '2026-06-12T00:00:00.000Z',
    });
    await api.startProject('operator');

    const result = await api.stopProject('operator');

    expect(result).toEqual({
      success: true,
      command: expect.objectContaining({ command: 'stop_project', status: 'completed', source: 'operator' }),
      intent: { status: 'stopped', updated_at: '2026-06-12T00:00:00.000Z', source_command_id: 'runtime-command-2', reason: 'runtime_project_cancelled' },
      run: expect.objectContaining({ phase: 'cancelled', runtime_status: 'cancelled' }),
    });
    expect(api.getStatus()).toMatchObject({ status: 'idle', currentCardId: null });
  }));
});
