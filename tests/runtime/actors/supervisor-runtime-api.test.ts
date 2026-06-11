import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { createSupervisorRuntimeApi, readActorSnapshots } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput, ProviderTurnPort, XStateChildCard } from '../../../src/runtime/actors/index.js';

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

  it('runs the project root through GoalCardRunner when provider wiring is supplied', async () => withTempProject(async (projectRoot) => {
    const providerTurn: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'project complete' })),
    };
    const api = createSupervisorRuntimeApi({
      projectRoot,
      providerTurn,
      rootCards: { read: jest.fn(() => ({ id: 'project', type: 'project' })) },
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.command.status).toBe('completed');
      expect(result.run).toMatchObject({ card_id: 'project', phase: 'completed', runtime_status: 'idle' });
      expect(result.intent.reason).toBe('xstate_project_done');
    }
    expect(providerTurn.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'planner:project',
      role: 'planner',
      sessionId: 'planner:project',
      tools: [expect.objectContaining({ function: expect.objectContaining({ name: 'activate_card' }) })],
    }));
    expect(readActorSnapshots(projectRoot).map((item) => item.actor_id).sort()).toEqual([
      'card:project',
      'planner:project',
      'supervisor',
    ]);
  }));

  it('rejects startProject when provider exists but the project card is missing', async () => withTempProject(async (projectRoot) => {
    const api = createSupervisorRuntimeApi({
      projectRoot,
      providerTurn: { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'unused' })) },
      rootCards: { read: jest.fn(() => null) },
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('xstate_project_card_missing');
  }));

  it('activates terminal children through XState child activation', async () => withTempProject(async (projectRoot) => {
    const providerTurn: ProviderTurnPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        if (input.role === 'executor') return { kind: 'message' as const, content: 'child executed' };
        if (!input.episodeContext.lastToolResult) {
          return {
            kind: 'tool_calls' as const,
            tool_calls: [{
              id: 'activate-terminal-child',
              type: 'function' as const,
              function: { name: 'activate_card', arguments: JSON.stringify({ cardId: 'T-child' }) },
            }],
          };
        }
        return { kind: 'message' as const, content: 'project complete after child' };
      }),
    };
    const cards = new Map<string, XStateChildCard>([
      ['project', { id: 'project', type: 'project' }],
      ['T-child', { id: 'T-child', type: 'code' }],
    ]);
    const api = createSupervisorRuntimeApi({
      projectRoot,
      providerTurn,
      rootCards: { read: jest.fn((cardId: string) => cards.get(cardId) ?? null) },
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(true);
    expect(providerTurn.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'planner:project' }));
    expect(providerTurn.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'executor:T-child',
      tools: expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: 'run_process' }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: 'wait_process' }) }),
      ]),
    }));
    expect(readActorSnapshots(projectRoot).map((item) => item.actor_id).sort()).toEqual([
      'card:T-child',
      'card:project',
      'executor:T-child',
      'planner:project',
      'supervisor',
    ]);
  }));
});
