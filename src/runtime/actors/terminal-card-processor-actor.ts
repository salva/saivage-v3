import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardActivationInput, CardActivationOutcome, CardProcessorActor } from './card-actor.js';
import { executorActorId } from './ids.js';
import type { LLMActorOutcome, LLMAdmissionPort, LLMProviderPort } from './llm-actor.js';
import { ProcessActor } from './process-actor.js';
import { TERMINAL_CARD_PROCESSOR_TOOL_DEFINITIONS } from './actor-tool-definitions.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { createExecutorContract } from '../../contracts/executor-contract.js';
import type { ExecutorResult } from '../../contracts/agent-execution.js';
import { expectedTerminalToolMessage, verifyTerminalToolOutcome } from './contract-terminal-tools.js';

type TerminalProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

export const MAX_TERMINAL_PROCESS_ACTORS = 20;

export class TerminalCardProcessorActor extends BaseMainLLMCardProcessorActor implements CardProcessorActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { activate: 'executing' } },
      executing: { on: { done: 'settled', failed: 'settled' } },
      settled: { parked: true, on: { activate: 'executing' } },
    },
  };

  readonly processes = new Map<string, ProcessActor>();

  constructor(args: { projectRoot: string; cardId: string; provider: LLMProviderPort; admission?: LLMAdmissionPort }) {
    super(args);
  }

  _on_enter__executing(): void {
    this.runPendingActivation('executing', (input, signal) => this.runActivation(input, signal));
  }

  protected override processorSnapshotContext(): Record<string, unknown> {
    return { ...super.processorSnapshotContext(), processIds: [...this.processes.keys()] };
  }

  private async runActivation(input: CardActivationInput, signal: AbortSignal): Promise<TerminalProcessorOutcome> {
    const llm = this.createMainLlm(executorActorId(this.cardId));
    let outcome = await llm.turn(this.buildLlmInput(input));
    for (let turn = 0; turn < 10; turn++) {
      if (signal.aborted) throw new Error('Terminal activation cancelled.');
      if (outcome.type === 'result') return { status: 'failed', summary: `${expectedTerminalToolMessage(createExecutorContract())} Plain executor messages are not accepted as terminal results.`, result: executorFailure(`${expectedTerminalToolMessage(createExecutorContract())} Plain executor messages are not accepted as terminal results.`) };
      if (outcome.type === 'error') return { status: 'failed', summary: outcome.error, result: executorFailure(outcome.error) };
      if (createExecutorContract().isTerminalToolName(outcome.toolName)) return this.projectExecutorTerminal(outcome);
      const toolResult = await this.handleToolCall(outcome);
      outcome = await llm.appendToolResult(outcome.toolCallId, toolResult, (inputId) => this.notificationContextMessages(input, inputId));
    }
    return { status: 'failed', summary: 'Executor exceeded terminal turn budget.', result: executorFailure('Executor exceeded terminal turn budget.') };
  }

  private buildLlmInput(input: CardActivationInput): LlmInvocationInput {
    const contract = createExecutorContract();
    const inputId = this.nextInvocationInputId('terminal');
    return {
      inputId,
      agentId: executorActorId(this.cardId),
      role: 'executor',
      sessionId: executorActorId(this.cardId),
      systemPrompt: `Execute terminal card ${input.card.id}: ${input.card.title}\n\n${input.card.description}\n\nAcceptance:\n${input.card.acceptance}\n\nUse process tools when needed. End by calling emit_executor_result; plain text or JSON messages are not accepted as terminal reports.`,
      contextMessages: this.notificationContextMessages(input, inputId),
      tools: [...TERMINAL_CARD_PROCESSOR_TOOL_DEFINITIONS, ...contract.terminals.map((terminal) => terminal.toolDefinition)],
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller },
    };
  }

  private async handleToolCall(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): Promise<unknown> {
    try {
      if (outcome.toolName === 'run_process') return this.runProcess(outcome.args, outcome.toolCallId);
      if (outcome.toolName === 'wait_process') return this.waitProcess(outcome.args);
      if (outcome.toolName === 'inspect_process') return this.inspectProcess(outcome.args);
      if (outcome.toolName === 'kill_process') return this.killProcess(outcome.args);
      throw new Error(`Unsupported executor tool call '${outcome.toolName}'.`);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async runProcess(args: unknown, fallbackProcessId: string): Promise<unknown> {
    const parsed = parseProcessStartArgs(args);
    const processId = parsed.processId ?? fallbackProcessId;
    const actor = new ProcessActor({ projectRoot: this.projectRoot, processId });
    actor.start();
    actor.launch({ command: parsed.command, args: parsed.args });
    this.processes.set(processId, actor);
    this.compactProcessActors();
    return actor.wait(parsed.timeoutMs);
  }

  private compactProcessActors(): void {
    if (this.processes.size <= MAX_TERMINAL_PROCESS_ACTORS) return;
    for (const [processId, actor] of this.processes) {
      if (this.processes.size <= MAX_TERMINAL_PROCESS_ACTORS) return;
      if (actor.state() === 'settled') this.processes.delete(processId);
    }
  }

  private async waitProcess(args: unknown): Promise<unknown> {
    const parsed = parseProcessWaitArgs(args);
    const actor = this.requireProcess(parsed.processId);
    return actor.wait(parsed.timeoutMs);
  }

  private inspectProcess(args: unknown): unknown {
    const parsed = parseProcessIdArgs(args);
    return this.requireProcess(parsed.processId).inspect();
  }

  private killProcess(args: unknown): unknown {
    const parsed = parseProcessIdArgs(args);
    const actor = this.requireProcess(parsed.processId);
    actor.kill('executor requested kill');
    return { status: 'kill_requested', processId: parsed.processId };
  }

  private requireProcess(processId: string): ProcessActor {
    const actor = this.processes.get(processId);
    if (!actor) throw new Error(`Process '${processId}' not found.`);
    return actor;
  }

  private projectExecutorTerminal(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): TerminalProcessorOutcome {
    let result: ExecutorResult;
    try {
      result = verifyTerminalToolOutcome(createExecutorContract(), outcome).result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'failed', summary: message, result: executorFailure(message) };
    }
    const summary = result.summary ?? result.status_text;
    if (result.status === 'done') return { status: 'done', summary, result: executorSuccess(result) };
    const error = result.error ?? summary;
    return { status: 'failed', summary: error, result: executorFailure(error, result.result ?? null, result.status_text) };
  }

  protected override transitionEventForOutcome(outcome: TerminalProcessorOutcome): string {
    return outcome.status === 'done' ? 'done' : 'failed';
  }

  protected get processorLabel(): string {
    return 'Terminal processor';
  }

  protected activationFailureOutcome(error: string): TerminalProcessorOutcome {
    return { status: 'failed', summary: error, result: executorFailure(error) };
  }
}

function executorSuccess(result: ExecutorResult) {
  const at = new Date().toISOString();
  const summary = result.summary ?? result.status_text;
  return { kind: 'executor_success' as const, executor: result.result ?? { summary }, generated_files: [], verified_at: at, latest_self_report: { result: 'done', outcome: 'done', summary, status_text: result.status_text, at }, warnings: [] };
}

function executorFailure(error: string, partialResult: Record<string, unknown> | null = null, statusText = error) {
  const at = new Date().toISOString();
  return { kind: 'executor_failure' as const, error, partial_result: partialResult, latest_self_report: { result: 'failed', outcome: 'failed', summary: error, status_text: statusText, at } };
}

function parseProcessStartArgs(args: unknown): { command: string; args: string[]; timeoutMs: number; processId?: string } {
  if (!args || typeof args !== 'object') throw new Error('run_process args must be an object.');
  const record = args as Record<string, unknown>;
  if (typeof record.command !== 'string' || record.command.length === 0) throw new Error('run_process.command must be a non-empty string.');
  if (record.args !== undefined && (!Array.isArray(record.args) || record.args.some((item) => typeof item !== 'string'))) throw new Error('run_process.args must be an array of strings.');
  if (record.processId !== undefined && typeof record.processId !== 'string') throw new Error('run_process.processId must be a string.');
  return { command: record.command, args: (record.args as string[] | undefined) ?? [], timeoutMs: parseTimeoutMs(record.timeoutMs), processId: record.processId };
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
