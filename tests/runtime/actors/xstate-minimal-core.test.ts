import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import {
  actorKindFromId,
  cardActorId,
  executorActorId,
  plannerActorId,
  readActorSnapshots,
  removeActorSnapshot,
  RuntimeSupervisorActor,
  saveActorSnapshot,
  actorSnapshotPath,
  actorMessagesPath,
  actorToolDeliveriesPath,
  actorToolCallStatusesPath,
  supervisorActorId,
  type LlmInvocationInput,
  type ProviderTurnPort,
} from '../../../src/runtime/actors/index.js';
import { TerminalCardRunnerController, type TerminalCardStatusPort } from '../../../src/runtime/actors/card-runner.js';
import { GoalCardRunnerController, type GoalCardStatusPort } from '../../../src/runtime/actors/goal-card-runner.js';
import { LlmRunnerController } from '../../../src/runtime/actors/llm-runner.js';
import { ProcessRunnerController } from '../../../src/runtime/actors/process-runner.js';
import { createTerminalCardStatusPort } from '../../../src/runtime/actors/terminal-card-status-port.js';
import { createGoalCardStatusPort } from '../../../src/runtime/actors/goal-card-status-port.js';
import type { LlmCompleteResult } from '../../../src/agents/llm-contracts.js';
import type { CardRecord } from '../../../src/schemas/index.js';

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

function plannerInput(cardId: string): Omit<LlmInvocationInput, 'agentId'> {
  return {
    inputId: `planner-input:${cardId}`,
    role: 'planner',
    sessionId: plannerActorId(cardId),
    systemPrompt: 'plan the goal',
    contextMessages: [],
    tools: [],
    terminalToolNames: [],
    modelParams: {},
    capabilityRequest: { requiresTools: true },
    episodeContext: { cardId },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await delay(10);
  }
}

async function eventually(assertion: () => void, timeoutMs = 1000): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(10);
    }
  }
  throw lastError;
}

describe('actor runtime components', () => {
  it('derives deterministic actor ids and kinds', () => {
    expect(supervisorActorId()).toBe('supervisor');
    expect(cardActorId('T-1')).toBe('card:T-1');
    expect(plannerActorId('G-1')).toBe('planner:G-1');
    expect(executorActorId('T-1')).toBe('executor:T-1');
    expect(actorKindFromId('supervisor')).toBe('supervisor');
    expect(actorKindFromId('card:T-1')).toBe('card');
    expect(actorKindFromId('executor:T-1')).toBe('llm');
  });

  it('persists actor snapshots in per-actor files with schema version envelope', () => withTempProject((projectRoot) => {
    const saved = saveActorSnapshot(projectRoot, {
      actor_id: 'card:T-1',
      actor_kind: 'card',
      state_value: 'done',
      context: { cardId: 'T-1' },
      updated_at: new Date().toISOString(),
    });

    expect(saved).toMatchObject({ actor_id: 'card:T-1', actor_kind: 'card', state_value: 'done' });
    expect(readActorSnapshots(projectRoot)).toMatchObject([
      { actor_id: 'card:T-1', actor_kind: 'card', state_value: 'done' },
    ]);
    expect(existsSync(actorSnapshotPath(projectRoot, 'card:T-1'))).toBe(true);
    expect(actorSnapshotPath(projectRoot, 'card:T-1')).toContain('.saivage/runtime/actors/card/');
  }));

  it('overwrites, sorts, and removes per-actor snapshots by actor id', () => withTempProject((projectRoot) => {
    saveActorSnapshot(projectRoot, {
      actor_id: 'executor:T-1',
      actor_kind: 'llm',
      state_value: 'running',
      context: { turn: 1 },
      updated_at: new Date().toISOString(),
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:T-1',
      actor_kind: 'card',
      state_value: 'executing',
      context: { cardId: 'T-1' },
      updated_at: new Date().toISOString(),
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'executor:T-1',
      actor_kind: 'llm',
      state_value: 'done',
      context: { turn: 2 },
      updated_at: new Date().toISOString(),
    });

    expect(readActorSnapshots(projectRoot).map((item) => `${item.actor_id}:${String(item.state_value)}`)).toEqual([
      'card:T-1:executing',
      'executor:T-1:done',
    ]);

    expect(removeActorSnapshot(projectRoot, 'card:T-1')).toBe(true);
    expect(removeActorSnapshot(projectRoot, 'card:T-1')).toBe(false);
    expect(readActorSnapshots(projectRoot).map((item) => item.actor_id)).toEqual(['executor:T-1']);
  }));

  it('supervisor owns one provider-call admission permit', () => withTempProject(async (projectRoot) => {
    const supervisor = new RuntimeSupervisorActor();
    supervisor.start();
    supervisor.initialize(projectRoot);
    supervisor.run();

    await eventually(() => { expect(supervisor.mode).toBe('running'); });
    expect(supervisor.work).toBe('ready');
    expect(supervisor.requestProviderCall({ callId: 'call-1' })).toBe(true);
    await eventually(() => { expect(supervisor.work).toBe('model_invocation_active'); });
    expect(supervisor.requestProviderCall({ callId: 'call-2' })).toBe(false);
    supervisor.releaseProviderCall({ callId: 'call-1' });
    await eventually(() => { expect(supervisor.work).toBe('ready'); });

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

  it('terminal CardRunner fails with the provider error reported by LLMRunner', async () => withTempProject(async (projectRoot) => {
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => {
        throw new Error('context_length_exceeded');
      }),
    };
    const runner = new TerminalCardRunnerController(projectRoot, 'T-provider-error', provider);

    const outcome = await runner.start(invocationInput('T-provider-error'));

    expect(outcome).toEqual({
      status: 'failed',
      statusText: 'context_length_exceeded',
      result: { kind: 'message', content: 'context_length_exceeded' },
    });
    expect(runner.publicStatus).toBe('failed');
    expect(readJsonl(actorMessagesPath(projectRoot, 'executor:T-provider-error')).map((entry) => entry.kind)).toEqual([
      'activity',
      'model_issue',
    ]);
  }));

  it('terminal CardRunner publishes running and terminal status through a narrow port', async () => withTempProject(async (projectRoot) => {
    const statusPort: TerminalCardStatusPort = {
      markRunning: jest.fn<(cardId: string) => void>(),
      markCancelled: jest.fn<(cardId: string) => void>(),
      commitTerminalOutcome: jest.fn<TerminalCardStatusPort['commitTerminalOutcome']>(),
    };
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'done' })),
    };
    const runner = new TerminalCardRunnerController(projectRoot, 'T-status', provider, undefined, 'backlog', statusPort);

    const outcome = await runner.start(invocationInput('T-status'));

    expect(statusPort.markRunning).toHaveBeenCalledWith('T-status');
    expect(statusPort.commitTerminalOutcome).toHaveBeenCalledWith('T-status', outcome);
    expect(statusPort.markCancelled).not.toHaveBeenCalled();
  }));

  it('terminal card status adapter writes lifecycle patches for terminal outcomes', () => {
    const store = {
      setStatus: jest.fn(() => ({} as CardRecord)),
      commitTerminalLifecyclePatch: jest.fn(() => ({} as CardRecord)),
    };
    const port = createTerminalCardStatusPort(store, () => '2026-06-12T00:00:00.000Z');

    port.markRunning('T-adapter');
    port.commitTerminalOutcome('T-adapter', {
      status: 'failed',
      statusText: 'executor failed',
      result: { kind: 'message', content: 'failure detail' },
    });

    expect(store.setStatus).toHaveBeenCalledWith('T-adapter', 'running');
    expect(store.commitTerminalLifecyclePatch).toHaveBeenCalledWith('T-adapter', expect.objectContaining({
      status: 'failed',
      status_text: 'executor failed',
      lifecycle: expect.objectContaining({ status: 'failed', error: 'executor failed' }),
    }));
  });

  it('goal card status adapter writes planner lifecycle patches for goal outcomes', () => {
    const store = {
      setStatus: jest.fn(() => ({} as CardRecord)),
      commitTerminalLifecyclePatch: jest.fn(() => ({} as CardRecord)),
    };
    const port = createGoalCardStatusPort(store, () => '2026-06-12T00:00:00.000Z');

    port.markRunning('G-adapter');
    port.commitGoalOutcome('G-adapter', { status: 'done', statusText: 'goal complete' });

    expect(store.setStatus).toHaveBeenCalledWith('G-adapter', 'running');
    expect(store.commitTerminalLifecyclePatch).toHaveBeenCalledWith('G-adapter', expect.objectContaining({
      status: 'done',
      status_text: 'goal complete',
      lifecycle: expect.objectContaining({ status: 'done', result: { kind: 'planner_done', summary: 'goal complete' } }),
    }));
  });

  it('LLMRunner emits generic tool-call output', async () => withTempProject(async (projectRoot) => {
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({
        kind: 'tool_calls' as const,
        tool_calls: [{
          id: 'tool-1',
          type: 'function' as const,
          function: { name: 'run_process', arguments: '{"command":"pwd"}' },
        }],
      })),
    };
    const runner = new LlmRunnerController(projectRoot, 'executor:T-tools', provider);

    const output = await runner.runTurn({ ...invocationInput('T-tools'), agentId: 'executor:T-tools' });

    expect(output).toEqual({
      type: 'LLM_TOOL_CALL',
      agentId: 'executor:T-tools',
      toolCallId: 'tool-1',
      toolName: 'run_process',
      args: { command: 'pwd' },
    });
    expect(readJsonl(actorMessagesPath(projectRoot, 'executor:T-tools')).map((entry) => entry.kind)).toEqual([
      'activity',
      'tool_call',
    ]);
    expect(readJsonl(actorToolCallStatusesPath(projectRoot, 'executor:T-tools'))).toMatchObject([
      { source_input_id: 'input:T-tools', tool_call_id: 'tool-1', tool_name: 'run_process', status: 'pending' },
    ]);
  }));

  it('LLMRunner respects supervisor provider-call admission', async () => withTempProject(async (projectRoot) => {
    const supervisor = new RuntimeSupervisorActor();
    supervisor.start();
    supervisor.initialize(projectRoot);
    supervisor.run();
    await eventually(() => { expect(supervisor.mode).toBe('running'); });
    expect(supervisor.requestProviderCall({ callId: 'external-call' })).toBe(true);
    await eventually(() => { expect(supervisor.work).toBe('model_invocation_active'); });
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'should not run' })),
    };
    const runner = new LlmRunnerController(projectRoot, 'executor:T-admission-denied', provider, supervisor);

    const denied = await runner.runTurn({ ...invocationInput('T-admission-denied'), agentId: 'executor:T-admission-denied' });

    expect(denied).toEqual({
      type: 'LLM_ERROR',
      agentId: 'executor:T-admission-denied',
      error: 'Provider admission denied for executor:T-admission-denied:input:T-admission-denied.',
    });
    expect(provider.completeTurn).not.toHaveBeenCalled();
    expect(readJsonl(actorMessagesPath(projectRoot, 'executor:T-admission-denied')).map((entry) => entry.kind)).toEqual([
      'activity',
      'model_issue',
    ]);
    supervisor.releaseProviderCall({ callId: 'external-call' });
  }));

  it('LLMRunner releases supervisor admission after provider completion', async () => withTempProject(async (projectRoot) => {
    const supervisor = new RuntimeSupervisorActor();
    supervisor.start();
    supervisor.initialize(projectRoot);
    supervisor.run();
    await eventually(() => { expect(supervisor.mode).toBe('running'); });
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'done' })),
    };
    const runner = new LlmRunnerController(projectRoot, 'executor:T-admission-release', provider, supervisor);

    const output = await runner.runTurn({ ...invocationInput('T-admission-release'), agentId: 'executor:T-admission-release' });

    expect(output.type).toBe('LLM_RESULT');
    await eventually(() => { expect(supervisor.work).toBe('ready'); });
    expect(supervisor.requestProviderCall({ callId: 'next-call' })).toBe(true);
    supervisor.releaseProviderCall({ callId: 'next-call' });
  }));

  it('terminal CardRunner fails clearly on unsupported executor tool calls', async () => withTempProject(async (projectRoot) => {
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({
        kind: 'tool_calls' as const,
        tool_calls: [{
          id: 'tool-unsupported',
          type: 'function' as const,
          function: { name: 'old_runtime_tool', arguments: '{}' },
        }],
      })),
    };
    const runner = new TerminalCardRunnerController(projectRoot, 'T-unsupported', provider);

    const outcome = await runner.start(invocationInput('T-unsupported'));

    expect(outcome.status).toBe('failed');
    expect(outcome.statusText).toBe("Unsupported executor tool call 'old_runtime_tool'.");
    expect(runner.publicStatus).toBe('failed');
    expect(readJsonl(actorToolCallStatusesPath(projectRoot, 'executor:T-unsupported'))).toMatchObject([
      { tool_call_id: 'tool-unsupported', tool_name: 'old_runtime_tool', status: 'pending' },
      { tool_call_id: 'tool-unsupported', tool_name: 'old_runtime_tool', status: 'errored', error: "Unsupported executor tool call 'old_runtime_tool'." },
    ]);
  }));

  it('terminal CardRunner lets the LLM keep waiting on a timed-out process', async () => withTempProject(async (projectRoot) => {
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        const lastToolResult = input.episodeContext.lastToolResult as { result?: { status?: string } } | undefined;
        if (!lastToolResult) {
          return {
            kind: 'tool_calls' as const,
            tool_calls: [{
              id: 'tool-run-process',
              type: 'function' as const,
              function: {
                name: 'run_process',
                arguments: JSON.stringify({
                  processId: 'p-flow',
                  command: process.execPath,
                  args: ['-e', "setTimeout(() => { process.stdout.write('done\\n'); }, 80);"],
                  timeoutMs: 10,
                }),
              },
            }],
          };
        }
        if (lastToolResult.result?.status === 'running') {
          return {
            kind: 'tool_calls' as const,
            tool_calls: [{
              id: 'tool-wait-process',
              type: 'function' as const,
              function: { name: 'wait_process', arguments: JSON.stringify({ processId: 'p-flow', timeoutMs: 1000 }) },
            }],
          };
        }
        return { kind: 'message' as const, content: 'process completed' };
      }),
    };
    const runner = new TerminalCardRunnerController(projectRoot, 'T-process-flow', provider);

    const outcome = await runner.start(invocationInput('T-process-flow'));

    expect(outcome.status).toBe('done');
    expect(provider.completeTurn).toHaveBeenCalledTimes(3);
    expect(readJsonl(actorToolDeliveriesPath(projectRoot, 'executor:T-process-flow')).map((entry) => entry.tool_name)).toEqual([
      'run_process',
      'wait_process',
    ]);
    expect(readJsonl(actorToolCallStatusesPath(projectRoot, 'executor:T-process-flow')).map((entry) => `${entry.tool_call_id}:${entry.status}`)).toEqual([
      'tool-run-process:pending',
      'tool-run-process:delivered',
      'tool-wait-process:pending',
      'tool-wait-process:delivered',
    ]);
    expect(readActorSnapshots(projectRoot).find((item) => item.actor_id === 'process:p-flow')).toMatchObject({
      actor_kind: 'process',
      state_value: 'done',
    });
  }));

  it('GoalCardRunner feeds child activation outcome back to planner', async () => withTempProject(async (projectRoot) => {
    const childActivation = {
      startChild: jest.fn(async () => ({ status: 'done' as const, statusText: 'child done' })),
    };
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        if (!input.episodeContext.lastToolResult) {
          return {
            kind: 'tool_calls' as const,
            tool_calls: [{
              id: 'activate-child',
              type: 'function' as const,
              function: { name: 'activate_card', arguments: JSON.stringify({ cardId: 'T-child' }) },
            }],
          };
        }
        return { kind: 'message' as const, content: 'goal complete' };
      }),
    };
    const runner = new GoalCardRunnerController(projectRoot, 'G-1', provider, childActivation);

    const outcome = await runner.start(plannerInput('G-1'));

    expect(outcome).toEqual({ status: 'done', statusText: 'goal complete' });
    expect(childActivation.startChild).toHaveBeenCalledWith('T-child');
    expect(provider.completeTurn).toHaveBeenCalledTimes(2);
    expect(readJsonl(actorToolDeliveriesPath(projectRoot, 'planner:G-1'))).toEqual([
      expect.objectContaining({
        tool_call_id: 'activate-child',
        tool_name: 'activate_card',
        delivery_input_id: 'planner-input:G-1:child:1',
        result: expect.objectContaining({ cardId: 'T-child', status: 'done', statusText: 'child done' }),
      }),
    ]);
    expect(readJsonl(actorToolCallStatusesPath(projectRoot, 'planner:G-1')).map((entry) => `${entry.tool_call_id}:${entry.status}`)).toEqual([
      'activate-child:pending',
      'activate-child:delivered',
    ]);
    expect(runner.phase).toBe('done');
    expect(runner.publicStatus).toBe('done');
    expect(readActorSnapshots(projectRoot).map((item) => item.actor_id).sort()).toContain('planner:G-1');
  }));

  it('GoalCardRunner reports failed child activation as goal failure', async () => withTempProject(async (projectRoot) => {
    const childActivation = {
      startChild: jest.fn(async () => ({ status: 'failed' as const, statusText: 'child failed' })),
    };
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({
        kind: 'tool_calls' as const,
        tool_calls: [{
          id: 'activate-child-failed',
          type: 'function' as const,
          function: { name: 'activate_card', arguments: JSON.stringify({ cardId: 'T-failed' }) },
        }],
      })),
    };
    const runner = new GoalCardRunnerController(projectRoot, 'G-2', provider, childActivation);

    const outcome = await runner.start(plannerInput('G-2'));

    expect(outcome).toEqual({ status: 'failed', statusText: 'child failed' });
    expect(provider.completeTurn).toHaveBeenCalledTimes(1);
    expect(runner.publicStatus).toBe('failed');
  }));

  it('GoalCardRunner reports blocked child activation as blocked goal outcome', async () => withTempProject(async (projectRoot) => {
    const childActivation = {
      startChild: jest.fn(async () => ({ status: 'blocked' as const, statusText: 'child blocked' })),
    };
    const statusPort: GoalCardStatusPort = {
      markRunning: jest.fn<(cardId: string) => void>(),
      markCancelled: jest.fn<(cardId: string) => void>(),
      commitGoalOutcome: jest.fn<GoalCardStatusPort['commitGoalOutcome']>(),
    };
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({
        kind: 'tool_calls' as const,
        tool_calls: [{
          id: 'activate-blocked-child',
          type: 'function' as const,
          function: { name: 'activate_card', arguments: JSON.stringify({ cardId: 'T-blocked' }) },
        }],
      })),
    };
    const runner = new GoalCardRunnerController(projectRoot, 'G-blocked-child', provider, childActivation, { statusPort });

    const outcome = await runner.start(plannerInput('G-blocked-child'));

    expect(outcome).toEqual({ status: 'blocked', statusText: 'child blocked' });
    expect(statusPort.commitGoalOutcome).toHaveBeenCalledWith('G-blocked-child', outcome);
    expect(runner.publicStatus).toBe('blocked');
  }));

  it('GoalCardRunner records errored status for unsupported planner tool calls', async () => withTempProject(async (projectRoot) => {
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({
        kind: 'tool_calls' as const,
        tool_calls: [{
          id: 'unsupported-planner-tool',
          type: 'function' as const,
          function: { name: 'old_planner_tool', arguments: '{}' },
        }],
      })),
    };
    const runner = new GoalCardRunnerController(
      projectRoot,
      'G-unsupported-tool',
      provider,
      { startChild: jest.fn(async () => ({ status: 'done' as const, statusText: 'unused' })) },
    );

    const outcome = await runner.start(plannerInput('G-unsupported-tool'));

    expect(outcome).toEqual({ status: 'failed', statusText: "Unsupported planner tool call 'old_planner_tool'." });
    expect(readJsonl(actorToolCallStatusesPath(projectRoot, 'planner:G-unsupported-tool'))).toMatchObject([
      { tool_call_id: 'unsupported-planner-tool', tool_name: 'old_planner_tool', status: 'pending' },
      { tool_call_id: 'unsupported-planner-tool', tool_name: 'old_planner_tool', status: 'errored', error: "Unsupported planner tool call 'old_planner_tool'." },
    ]);
  }));

  it('GoalCardRunner completes after reviewer pass', async () => withTempProject(async (projectRoot) => {
    const plannerProvider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'planner done' })),
    };
    const reviewerProvider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'pass' })),
    };
    const runner = new GoalCardRunnerController(
      projectRoot,
      'G-reviewed-pass',
      plannerProvider,
      { startChild: jest.fn(async () => ({ status: 'done' as const, statusText: 'unused' })) },
      { reviewerProviderTurn: reviewerProvider },
    );

    const outcome = await runner.start(plannerInput('G-reviewed-pass'));

    expect(outcome).toEqual({ status: 'done', statusText: 'planner done' });
    expect(reviewerProvider.completeTurn).toHaveBeenCalledTimes(1);
    expect(readActorSnapshots(projectRoot).map((item) => item.actor_id).sort()).toEqual([
      'card:G-reviewed-pass',
      'planner:G-reviewed-pass',
      'reviewer:G-reviewed-pass',
    ]);
  }));

  it('GoalCardRunner returns reviewer corrections to planner', async () => withTempProject(async (projectRoot) => {
    const plannerProvider: ProviderTurnPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        if (input.episodeContext.lastReviewResult) return { kind: 'message' as const, content: 'corrected planner done' };
        return { kind: 'message' as const, content: 'initial planner done' };
      }),
    };
    const reviewerProvider: ProviderTurnPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        if (input.episodeContext.plannerSummary === 'initial planner done') {
          return { kind: 'message' as const, content: 'needs_corrections: fix evidence' };
        }
        return { kind: 'message' as const, content: 'pass' };
      }),
    };
    const runner = new GoalCardRunnerController(
      projectRoot,
      'G-reviewed-corrected',
      plannerProvider,
      { startChild: jest.fn(async () => ({ status: 'done' as const, statusText: 'unused' })) },
      { reviewerProviderTurn: reviewerProvider },
    );

    const outcome = await runner.start(plannerInput('G-reviewed-corrected'));

    expect(outcome).toEqual({ status: 'done', statusText: 'corrected planner done' });
    expect(plannerProvider.completeTurn).toHaveBeenCalledTimes(2);
    expect(reviewerProvider.completeTurn).toHaveBeenCalledTimes(2);
    expect(plannerProvider.completeTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      episodeContext: expect.objectContaining({
        lastReviewResult: { result: 'needs_corrections', summary: 'fix evidence' },
      }),
    }));
    expect(runner.publicStatus).toBe('done');
  }));

  it('GoalCardRunner delivers pending notes to planner once by note id', async () => withTempProject(async (projectRoot) => {
    const seenNotes: unknown[] = [];
    const plannerProvider: ProviderTurnPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        seenNotes.push(input.episodeContext.pendingNotes ?? []);
        return { kind: 'message' as const, content: 'planner saw notes' };
      }),
    };
    const runner = new GoalCardRunnerController(
      projectRoot,
      'G-notes',
      plannerProvider,
      { startChild: jest.fn(async () => ({ status: 'done' as const, statusText: 'unused' })) },
    );
    runner.addNote({ id: 'note-1', content: 'card changed' });
    runner.addNote({ id: 'note-1', content: 'duplicate ignored' });

    const outcome = await runner.start(plannerInput('G-notes'));

    expect(outcome.status).toBe('done');
    expect(seenNotes).toEqual([[{ id: 'note-1', content: 'card changed' }]]);
    expect(readActorSnapshots(projectRoot).find((item) => item.actor_id === 'card:G-notes')?.context).toMatchObject({
      noteBox: { pendingNoteIds: [], deliveredNoteIds: ['note-1'] },
    });
  }));

  it('terminal CardRunner cancellation is a no-op after completion', () => withTempProject(async (projectRoot) => {
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'unused' })),
    };
    const runner = new TerminalCardRunnerController(projectRoot, 'T-2', provider);

    await runner.cancel();

    expect(runner.phase).toBe('done');
    expect(runner.publicStatus).toBe('backlog');
  }));

  it('GoalCardRunner cancellation is a no-op after completion', async () => withTempProject(async (projectRoot) => {
    const provider: ProviderTurnPort = {
      completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'unused' })),
    };
    const statusPort: GoalCardStatusPort = {
      markRunning: jest.fn<(cardId: string) => void>(),
      markCancelled: jest.fn<(cardId: string) => void>(),
      commitGoalOutcome: jest.fn<GoalCardStatusPort['commitGoalOutcome']>(),
    };
    const runner = new GoalCardRunnerController(
      projectRoot,
      'G-cancel',
      provider,
      { startChild: jest.fn(async () => ({ status: 'done' as const, statusText: 'unused' })) },
      { statusPort },
    );

    await runner.cancel();

    expect(runner.phase).toBe('done');
    expect(runner.publicStatus).toBe('backlog');
    expect(statusPort.markCancelled).not.toHaveBeenCalled();
  }));

  it('ProcessRunner timeout returns control without killing the process', async () => withTempProject(async (projectRoot) => {
    const runner = new ProcessRunnerController(projectRoot, 'P-1');
    await runner.start({
      command: process.execPath,
      args: ['-e', "process.stdout.write('ready\\n'); setTimeout(() => { process.stdout.write('done\\n'); }, 120);"],
    });
    await waitFor(() => runner.readOutput().stdout.includes('ready'));

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
    await runner.start({
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
