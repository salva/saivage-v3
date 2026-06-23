import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardActivationInput, CardActivationOutcome, CardProcessorActor } from './card-actor.js';
import { executorActorId, processorActorId } from './ids.js';
import { saveActorSnapshot } from './snapshots.js';
import { LLMActor, type LLMActorOutcome, type LLMAdmissionPort, type LLMProviderPort } from './llm-actor.js';
import { ProcessActor } from './process-actor.js';
import { XSTATE_PROCESS_TOOL_DEFINITIONS } from './actor-tool-definitions.js';
import type { LlmInvocationInput } from './llm-invocation.js';

type TerminalProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

type PendingActivation = {
  input: CardActivationInput;
  resolve: (outcome: TerminalProcessorOutcome) => void;
  reject: (error: Error) => void;
};

export class TerminalCardProcessorActor extends BaseActor implements CardProcessorActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { activate: 'executing', cancel: 'cancelled' } },
      executing: { on: { done: 'settled', failed: 'settled', cancel: 'cancelled' } },
      settled: { parked: true, on: { activate: 'executing', cancel: 'cancelled' } },
      cancelled: { terminal: true },
    },
  };

  readonly projectRoot: string;
  readonly cardId: string;
  readonly provider: LLMProviderPort;
  readonly admission?: LLMAdmissionPort;
  readonly processes = new Map<string, ProcessActor>();
  outcome: TerminalProcessorOutcome | null = null;
  cancelReason: string | null = null;
  #pending: PendingActivation | null = null;
  #activationCounter = 0;

  constructor(args: { projectRoot: string; cardId: string; provider: LLMProviderPort; admission?: LLMAdmissionPort }) {
    super();
    this.projectRoot = args.projectRoot;
    this.cardId = args.cardId;
    this.provider = args.provider;
    this.admission = args.admission;
  }

  activate(input: CardActivationInput): Promise<TerminalProcessorOutcome> {
    if (this.#pending) return Promise.reject(new Error(`Terminal processor '${this.cardId}' already has a pending activation.`));
    if (this.state() !== 'idle' && this.state() !== 'settled') return Promise.reject(new Error(`Terminal processor '${this.cardId}' cannot activate from '${this.state()}'.`));
    return new Promise<TerminalProcessorOutcome>((resolve, reject) => {
      this.#pending = { input, resolve, reject };
      this.parkedSendEvent('activate');
    });
  }

  cancel(reason: string): void {
    this.cancelReason = reason;
    this.#pending?.reject(new Error(reason));
    this.#pending = null;
    if (this.state() === 'idle' || this.state() === 'settled') this.parkedSendEvent('cancel');
    this.persist();
  }

  _on_enter__executing(): void {
    const pending = this.#pending;
    if (!pending) throw new Error(`Terminal processor '${this.cardId}' entered executing without activation input.`);
    this.runTask(async (signal) => this.runActivation(pending.input, signal), {
      on_done: (outcome) => {
        this.outcome = outcome;
        pending.resolve(outcome);
        this.#pending = null;
        this.sendEvent(outcome.status === 'done' ? 'done' : 'failed');
      },
      on_failed: (error) => {
        const outcome: TerminalProcessorOutcome = { status: 'failed', summary: error.message, result: executorFailure(error.message) };
        this.outcome = outcome;
        pending.resolve(outcome);
        this.#pending = null;
        this.sendEvent('failed');
      },
    });
  }

  protected override _on_state_changed(_oldState: string | undefined, _newState: string): void {
    this.persist();
  }

  snapshot() {
    return {
      actor_id: processorActorId(this.cardId),
      actor_kind: 'processor' as const,
      state_value: this.state(),
      context: { projectRoot: this.projectRoot, cardId: this.cardId, outcome: this.outcome, cancelReason: this.cancelReason, processIds: [...this.processes.keys()] },
      updated_at: new Date().toISOString(),
    };
  }

  private async runActivation(input: CardActivationInput, signal: AbortSignal): Promise<TerminalProcessorOutcome> {
    const llm = new LLMActor({ projectRoot: this.projectRoot, agentId: executorActorId(this.cardId), provider: this.provider, admission: this.admission });
    llm.start();
    let outcome = await llm.turn(this.buildLlmInput(input));
    for (let turn = 0; turn < 10; turn++) {
      if (signal.aborted) throw new Error('Terminal activation cancelled.');
      if (outcome.type === 'result') return { status: 'done', summary: outcome.result.content, result: executorSuccess(outcome.result.content) };
      if (outcome.type === 'error') return { status: 'failed', summary: outcome.error, result: executorFailure(outcome.error) };
      const toolResult = await this.handleToolCall(outcome);
      outcome = await llm.appendToolResult(outcome.toolCallId, toolResult);
    }
    return { status: 'failed', summary: 'Executor exceeded terminal turn budget.', result: executorFailure('Executor exceeded terminal turn budget.') };
  }

  private buildLlmInput(input: CardActivationInput): LlmInvocationInput {
    this.#activationCounter++;
    return {
      inputId: `terminal:${this.cardId}:${this.#activationCounter}`,
      agentId: executorActorId(this.cardId),
      role: 'executor',
      sessionId: executorActorId(this.cardId),
      systemPrompt: `Execute terminal card ${input.card.id}: ${input.card.title}\n\n${input.card.description}\n\nAcceptance:\n${input.card.acceptance}`,
      contextMessages: input.notifications.map((notification) => ({ role: 'user', content: notification.message })),
      tools: XSTATE_PROCESS_TOOL_DEFINITIONS,
      terminalToolNames: [],
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
    return actor.wait(parsed.timeoutMs);
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

  private persist(): void {
    saveActorSnapshot(this.projectRoot, this.snapshot());
  }
}

function executorSuccess(summary: string) {
  const at = new Date().toISOString();
  return { kind: 'executor_success' as const, executor: { summary }, generated_files: [], verified_at: at, latest_self_report: { result: 'done', outcome: 'done', summary, status_text: summary, at }, warnings: [] };
}

function executorFailure(error: string) {
  const at = new Date().toISOString();
  return { kind: 'executor_failure' as const, error, partial_result: null, latest_self_report: { result: 'failed', outcome: 'failed', summary: error, status_text: error, at } };
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
