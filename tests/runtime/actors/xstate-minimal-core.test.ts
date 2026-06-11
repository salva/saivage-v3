import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import {
  actorKindFromId,
  cardActorId,
  executorActorId,
  plannerActorId,
  readActorSnapshots,
  RuntimeSupervisorController,
  saveActorSnapshot,
  supervisorActorId,
  TerminalCardRunnerController,
  ProcessRunnerController,
  type LlmInvocationInput,
  type ProviderTurnPort,
} from '../../../src/runtime/actors/index.js';
import type { LlmCompleteResult } from '../../../src/agents/llm-contracts.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-xstate-core-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) {
    return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  }
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function invocationInput(cardId: string): Omit<LlmInvocationInput, 'agentId'> {
  return {
    inputId: `input:${cardId}`,
    role: 'executor',
    sessionId: executorActorId(cardId),
    systemPrompt: 'execute the card',
    contextMessages: [],
    tools: [],
    terminalToolNames: [],
    modelParams: {},
    capabilityRequest: { requiresTools: false },
    episodeContext: { cardId },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('XState minimal runtime core', () => {
  it('derives deterministic actor ids and kinds', () => {
    expect(supervisorActorId()).toBe('supervisor');
    expect(cardActorId('T-1')).toBe('card:T-1');
    expect(plannerActorId('G-1')).toBe('planner:G-1');
    expect(executorActorId('T-1')).toBe('executor:T-1');
    expect(actorKindFromId('supervisor')).toBe('supervisor');
    expect(actorKindFromId('card:T-1')).toBe('card');
    expect(actorKindFromId('executor:T-1')).toBe('llm');
  });

  it('persists actor snapshots with schema version envelope', () => withTempProject((projectRoot) => {
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:T-1',
      actor_kind: 'card',
      state_value: 'done',
      context: { cardId: 'T-1' },
      updated_at: new Date().toISOString(),
    });

    expect(readActorSnapshots(projectRoot)).toMatchObject([
      { actor_id: 'card:T-1', actor_kind: 'card', state_value: 'done' },
    ]);
  }));

  it('supervisor owns one provider-call admission permit', () => withTempProject((projectRoot) => {
    const supervisor = new RuntimeSupervisorController();
    supervisor.start(projectRoot);

    expect(supervisor.mode).toBe('running');
    expect(supervisor.work).toBe('ready');
    expect(supervisor.requestProviderCall('call-1')).toBe(true);
    expect(supervisor.work).toBe('model_invocation_active');
    expect(supervisor.requestProviderCall('call-2')).toBe(false);
    supervisor.releaseProviderCall('call-1');
    expect(supervisor.work).toBe('ready');

    const snapshots = readActorSnapshots(projectRoot);
    expect(snapshots.some((item) => item.actor_id === 'supervisor')).toBe(true);
  }));

  it('terminal CardRunner executes through executor LLMRunner', async () => withTempProject(async (projectRoot) => {
    const result: LlmCompleteResult = { kind: 'message', content: 'done' };
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => result),
    };
    const runner = new TerminalCardRunnerController(projectRoot, 'T-1', provider);

    const outcome = await runner.start(invocationInput('T-1'));

    expect(outcome.status).toBe('done');
    expect(runner.phase).toBe('done');
    expect(runner.publicStatus).toBe('done');
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'executor:T-1',
      inputId: 'input:T-1',
      role: 'executor',
    }));
    expect(readActorSnapshots(projectRoot).map((item) => item.actor_id).sort()).toEqual([
      'card:T-1',
      'executor:T-1',
    ]);
  }));

  it('terminal CardRunner cancellation is a simple terminal transition', () => withTempProject((projectRoot) => {
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'unused' })),
    };
    const runner = new TerminalCardRunnerController(projectRoot, 'T-2', provider);

    runner.cancel();

    expect(runner.phase).toBe('done');
    expect(runner.publicStatus).toBe('cancelled');
  }));

  it('ProcessRunner timeout returns control without killing the process', async () => withTempProject(async (projectRoot) => {
    const runner = new ProcessRunnerController(projectRoot, 'P-1');
    runner.start({
      command: process.execPath,
      args: ['-e', "process.stdout.write('ready\\n'); setTimeout(() => { process.stdout.write('done\\n'); }, 120);"],
    });
    await delay(30);

    const timedOut = await runner.wait(20);

    expect(timedOut.status).toBe('running');
    expect(timedOut.output.stdout).toContain('ready');
    expect(runner.state).toBe('running');
    expect(runner.readOutput().stdout).toContain('ready');

    const completed = await runner.wait(1000);
    expect(completed.status).toBe('done');
    expect(completed.output.stdout).toContain('done');
    expect(runner.state).toBe('done');

    const processSnapshot = readActorSnapshots(projectRoot).find((item) => item.actor_id === 'process:P-1');
    expect(processSnapshot).toMatchObject({ actor_kind: 'process', state_value: 'done' });
  }));

  it('ProcessRunner kills a running process only when explicitly requested', async () => withTempProject(async (projectRoot) => {
    const runner = new ProcessRunnerController(projectRoot, 'P-2');
    runner.start({
      command: process.execPath,
      args: ['-e', "process.stdout.write('looping\\n'); setInterval(() => {}, 1000);"],
    });

    const timedOut = await runner.wait(20);
    expect(timedOut.status).toBe('running');

    runner.kill();
    const killed = await runner.wait(1000);

    expect(killed.status).toBe('done');
    if (killed.status === 'done') expect(killed.signal).toBe('SIGTERM');
    expect(runner.state).toBe('done');
  }));
});
