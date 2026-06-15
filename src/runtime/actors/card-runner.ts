import type { LlmCompleteResult } from '../../agents/llm-contracts.js';
import { BaseActor, startActor } from '../fsm/index.js';
import { cardActorId, executorActorId } from './ids.js';
import { LlmRunnerController } from './llm-runner.js';
import { saveActorSnapshot } from './snapshots.js';
import type { LlmInvocationInput, ProviderTurnPort } from './llm-runner.js';
import { ProcessRunnerController } from './process-runner.js';
import type { AdmissionPort } from './llm-runner.js';
import { appendToolCallStatus, appendToolDelivery } from './llm-delivery-log.js';

export type TerminalCardPublicStatus = 'backlog' | 'running' | 'done' | 'failed' | 'blocked' | 'needs_verification' | 'cancelled';

export interface TerminalOutcome {
  status: Exclude<TerminalCardPublicStatus, 'backlog' | 'running'>;
  statusText: string;
  result: LlmCompleteResult;
}

export interface TerminalCardStatusPort {
  markRunning(cardId: string): void | Promise<void>;
  markCancelled(cardId: string): void | Promise<void>;
  commitTerminalOutcome(cardId: string, outcome: TerminalOutcome): void | Promise<void>;
}

export interface TerminalCardRunnerContext {
  projectRoot: string;
  cardId: string;
  publicStatus: TerminalCardPublicStatus;
  outcome: TerminalOutcome | null;
}

export class TerminalCardRunnerActor extends BaseActor {
  static _actor = {
    initial: 'done',
    states: {
      done: {
        on: { start: 'executing', cancel: 'done' },
        calls: { start: 'recordStart', cancel: 'recordCancel' },
      },
      executing: {
        on: { done: 'done', failed: 'done', cancel: 'done' },
        calls: { outcome: 'recordOutcome', cancel: 'recordCancel' },
      },
    },
  };

  outcome: TerminalOutcome | null = null;

  constructor(
    readonly projectRoot: string,
    readonly cardId: string,
    publicStatus: TerminalCardPublicStatus = 'backlog',
  ) {
    super();
    this.publicStatus = publicStatus;
  }

  publicStatus: TerminalCardPublicStatus;

  recordStart(): void {
    this.publicStatus = 'running';
    this.outcome = null;
  }

  recordOutcome(outcome: TerminalOutcome): void {
    this.publicStatus = outcome.status;
    this.outcome = outcome;
  }

  recordCancel(): void {
    this.publicStatus = 'cancelled';
  }

  _on_enter__executing(): void {
    this.persist();
  }

  _on_enter__done(): void {
    this.persist();
  }

  context(): TerminalCardRunnerContext {
    return {
      projectRoot: this.projectRoot,
      cardId: this.cardId,
      publicStatus: this.publicStatus,
      outcome: this.outcome,
    };
  }

  snapshot() {
    return {
      actor_id: cardActorId(this.cardId),
      actor_kind: 'card' as const,
      state_value: this.state(),
      context: this.context() as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    saveActorSnapshot(this.projectRoot, this.snapshot());
  }
}

export class TerminalCardRunnerController {
  private readonly actor: TerminalCardRunnerActor;
  private readonly llmRunner: LlmRunnerController;
  private readonly processes = new Map<string, ProcessRunnerController>();

  constructor(
    projectRoot: string,
    readonly cardId: string,
    providerTurn: ProviderTurnPort,
    admission?: AdmissionPort,
    publicStatus: TerminalCardPublicStatus = 'backlog',
    private readonly statusPort?: TerminalCardStatusPort,
  ) {
    this.actor = startActor(TerminalCardRunnerActor, projectRoot, cardId, publicStatus);
    this.llmRunner = new LlmRunnerController(projectRoot, executorActorId(cardId), providerTurn, admission);
  }

  async start(input: Omit<LlmInvocationInput, 'agentId'>): Promise<TerminalOutcome> {
    this.actor.call('start');
    this.actor.send('start');
    await this.actor.waitForState((s) => s === 'executing');
    await this.statusPort?.markRunning(this.cardId);
    let currentInput = input;
    for (let turn = 0; turn < 10; turn++) {
      const output = await this.llmRunner.runTurn({ ...currentInput, agentId: executorActorId(this.cardId) });
      if (output.type === 'LLM_RESULT') {
        const outcome: TerminalOutcome = { status: 'done', statusText: 'Executor completed.', result: output.result };
        return this.complete(outcome);
      }
      if (output.type === 'LLM_ERROR') {
        return this.fail(output.error);
      }
      let toolResult: { handled: true; result: unknown } | { handled: false };
      try {
        toolResult = await this.handleExecutorToolCall(output.toolCallId, output.toolName, output.args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.recordToolError(currentInput.inputId, output.toolCallId, output.toolName, message);
        return this.fail(message);
      }
      if (!toolResult.handled) {
        const message = `Unsupported executor tool call '${output.toolName}'.`;
        this.recordToolError(currentInput.inputId, output.toolCallId, output.toolName, message);
        return this.fail(message);
      }
      const deliveryInputId = `${input.inputId}:tool:${turn + 1}`;
      appendToolDelivery(this.actor.projectRoot, {
        agent_id: executorActorId(this.cardId),
        source_input_id: currentInput.inputId,
        delivery_input_id: deliveryInputId,
        tool_call_id: output.toolCallId,
        tool_name: output.toolName,
        result: toolResult.result,
      });
      currentInput = {
        ...currentInput,
        inputId: deliveryInputId,
        episodeContext: {
          ...currentInput.episodeContext,
          lastToolResult: {
            toolCallId: output.toolCallId,
            toolName: output.toolName,
            result: toolResult.result,
          },
        },
      };
    }
    return this.fail('Executor exceeded the terminal CardRunner turn budget.');
  }

  private async complete(outcome: TerminalOutcome): Promise<TerminalOutcome> {
    this.actor.call('outcome', outcome);
    this.actor.send(outcome.status === 'done' ? 'done' : 'failed');
    await this.actor.waitForState((s) => s === 'done');
    await this.statusPort?.commitTerminalOutcome(this.cardId, outcome);
    return outcome;
  }

  private async fail(statusText: string): Promise<TerminalOutcome> {
    const outcome: TerminalOutcome = {
      status: 'failed',
      statusText,
      result: { kind: 'message', content: statusText },
    };
    return this.complete(outcome);
  }

  private async handleExecutorToolCall(toolCallId: string, toolName: string, args: unknown): Promise<{ handled: true; result: unknown } | { handled: false }> {
    if (toolName === 'run_process') {
      const parsed = parseProcessStartArgs(args);
      const processId = parsed.processId ?? toolCallId;
      const runner = new ProcessRunnerController(this.actor.projectRoot, processId);
      this.processes.set(processId, runner);
      await runner.start({ command: parsed.command, args: parsed.args });
      return { handled: true, result: await runner.wait(parsed.timeoutMs) };
    }
    if (toolName === 'wait_process') {
      const parsed = parseProcessWaitArgs(args);
      const runner = this.processes.get(parsed.processId);
      if (!runner) return { handled: true, result: { status: 'missing_process', processId: parsed.processId } };
      return { handled: true, result: await runner.wait(parsed.timeoutMs) };
    }
    if (toolName === 'inspect_process') {
      const parsed = parseProcessIdArgs(args);
      const runner = this.processes.get(parsed.processId);
      if (!runner) return { handled: true, result: { status: 'missing_process', processId: parsed.processId } };
      return { handled: true, result: { status: runner.state, output: runner.readOutput() } };
    }
    if (toolName === 'kill_process') {
      const parsed = parseProcessIdArgs(args);
      const runner = this.processes.get(parsed.processId);
      if (!runner) return { handled: true, result: { status: 'missing_process', processId: parsed.processId } };
      runner.kill();
      return { handled: true, result: await runner.wait(1000) };
    }
    return { handled: false };
  }

  private recordToolError(sourceInputId: string, toolCallId: string, toolName: string, error: string): void {
    appendToolCallStatus(this.actor.projectRoot, {
      agent_id: executorActorId(this.cardId),
      source_input_id: sourceInputId,
      tool_call_id: toolCallId,
      tool_name: toolName,
      status: 'errored',
      error,
    });
  }

  async cancel(): Promise<void> {
    this.actor.call('cancel');
    this.actor.send('cancel');
    await this.actor.waitForState((s) => s === 'done');
    await this.statusPort?.markCancelled(this.cardId);
  }

  get phase(): 'done' | 'executing' {
    return this.actor.state() as 'done' | 'executing';
  }

  get publicStatus(): TerminalCardPublicStatus {
    return this.actor.publicStatus;
  }

  snapshot() {
    return this.actor.snapshot();
  }
}

function parseProcessStartArgs(args: unknown): { command: string; args: string[]; timeoutMs: number; processId?: string } {
  if (!args || typeof args !== 'object') throw new Error('run_process args must be an object.');
  const record = args as Record<string, unknown>;
  if (typeof record.command !== 'string' || record.command.length === 0) throw new Error('run_process.command must be a non-empty string.');
  if (record.args !== undefined && (!Array.isArray(record.args) || record.args.some((item) => typeof item !== 'string'))) {
    throw new Error('run_process.args must be an array of strings.');
  }
  if (record.processId !== undefined && typeof record.processId !== 'string') throw new Error('run_process.processId must be a string.');
  return {
    command: record.command,
    args: (record.args as string[] | undefined) ?? [],
    timeoutMs: parseTimeoutMs(record.timeoutMs),
    processId: record.processId,
  };
}

function parseProcessWaitArgs(args: unknown): { processId: string; timeoutMs: number } {
  const parsed = parseProcessIdArgs(args);
  return { ...parsed, timeoutMs: parseTimeoutMs((args as Record<string, unknown>).timeoutMs) };
}

function parseProcessIdArgs(args: unknown): { processId: string } {
  if (!args || typeof args !== 'object') throw new Error('process args must be an object.');
  const processId = (args as Record<string, unknown>).processId;
  if (typeof processId !== 'string' || processId.length === 0) throw new Error('processId must be a non-empty string.');
  return { processId };
}

function parseTimeoutMs(value: unknown): number {
  if (value === undefined) return 1000;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('timeoutMs must be a non-negative number.');
  return value;
}