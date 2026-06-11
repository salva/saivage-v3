import { assign, createActor, createMachine } from 'xstate';
import type { LlmCompleteResult } from '../../agents/llm-contracts.js';
import { cardActorId, executorActorId } from './ids.js';
import { LlmRunnerController } from './llm-runner.js';
import { saveActorSnapshot } from './snapshots.js';
import type { LlmInvocationInput, ProviderTurnPort } from './llm-runner.js';
import { ProcessRunnerController } from './process-runner.js';
import type { AdmissionPort } from './llm-runner.js';

export type TerminalCardPublicStatus = 'backlog' | 'running' | 'done' | 'failed' | 'blocked' | 'needs_verification' | 'cancelled';

export interface TerminalOutcome {
  status: Exclude<TerminalCardPublicStatus, 'backlog' | 'running'>;
  statusText: string;
  result: LlmCompleteResult;
}

interface TerminalCardRunnerContext {
  projectRoot: string;
  cardId: string;
  publicStatus: TerminalCardPublicStatus;
  outcome: TerminalOutcome | null;
}

type TerminalCardRunnerEvent =
  | { type: 'START' }
  | { type: 'TERMINAL_OUTCOME'; outcome: TerminalOutcome }
  | { type: 'CANCEL' };

const terminalCardRunnerMachine = createMachine({
  types: {} as {
    context: TerminalCardRunnerContext;
    events: TerminalCardRunnerEvent;
  },
  id: 'terminalCardRunner',
  initial: 'done',
  context: ({ input }: { input: { projectRoot: string; cardId: string; publicStatus?: TerminalCardPublicStatus } }) => ({
    projectRoot: input.projectRoot,
    cardId: input.cardId,
    publicStatus: input.publicStatus ?? 'backlog',
    outcome: null,
  }),
  states: {
    done: {
      on: {
        START: {
          target: 'executing',
          actions: assign({ publicStatus: 'running', outcome: null }),
        },
        CANCEL: {
          actions: assign({ publicStatus: 'cancelled' }),
        },
      },
    },
    executing: {
      on: {
        TERMINAL_OUTCOME: {
          target: 'done',
          actions: assign({ publicStatus: ({ event }) => event.outcome.status, outcome: ({ event }) => event.outcome }),
        },
        CANCEL: {
          target: 'done',
          actions: assign({ publicStatus: 'cancelled' }),
        },
      },
    },
  },
});

export class TerminalCardRunnerController {
  private readonly actor;
  private readonly llmRunner: LlmRunnerController;
  private readonly processes = new Map<string, ProcessRunnerController>();

  constructor(
    projectRoot: string,
    readonly cardId: string,
    providerTurn: ProviderTurnPort,
    admission?: AdmissionPort,
    publicStatus: TerminalCardPublicStatus = 'backlog',
  ) {
    this.actor = createActor(terminalCardRunnerMachine, { input: { projectRoot, cardId, publicStatus } });
    this.llmRunner = new LlmRunnerController(projectRoot, executorActorId(cardId), providerTurn, admission);
    this.actor.start();
  }

  async start(input: Omit<LlmInvocationInput, 'agentId'>): Promise<TerminalOutcome> {
    this.actor.send({ type: 'START' });
    this.persist();
    let currentInput = input;
    for (let turn = 0; turn < 10; turn++) {
      const output = await this.llmRunner.runTurn({ ...currentInput, agentId: executorActorId(this.cardId) });
      if (output.type === 'LLM_RESULT') {
        const outcome: TerminalOutcome = { status: 'done', statusText: 'Executor completed.', result: output.result };
        this.actor.send({ type: 'TERMINAL_OUTCOME', outcome });
        this.persist();
        return outcome;
      }
      if (output.type === 'LLM_ERROR') {
        return this.fail(output.error);
      }
      let toolResult: { handled: true; result: unknown } | { handled: false };
      try {
        toolResult = await this.handleExecutorToolCall(output.toolCallId, output.toolName, output.args);
      } catch (error) {
        return this.fail(error instanceof Error ? error.message : String(error));
      }
      if (!toolResult.handled) return this.fail(`Unsupported executor tool call '${output.toolName}'.`);
      currentInput = {
        ...currentInput,
        inputId: `${input.inputId}:tool:${turn + 1}`,
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

  private fail(statusText: string): TerminalOutcome {
    const outcome: TerminalOutcome = {
      status: 'failed',
      statusText,
      result: { kind: 'message', content: statusText },
    };
    this.actor.send({ type: 'TERMINAL_OUTCOME', outcome });
    this.persist();
    return outcome;
  }

  private async handleExecutorToolCall(toolCallId: string, toolName: string, args: unknown): Promise<{ handled: true; result: unknown } | { handled: false }> {
    if (toolName === 'run_process') {
      const parsed = parseProcessStartArgs(args);
      const processId = parsed.processId ?? toolCallId;
      const runner = new ProcessRunnerController(this.actor.getSnapshot().context.projectRoot, processId);
      this.processes.set(processId, runner);
      runner.start({ command: parsed.command, args: parsed.args });
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

  cancel(): void {
    this.actor.send({ type: 'CANCEL' });
    this.persist();
  }

  get phase(): 'done' | 'executing' {
    return this.actor.getSnapshot().value as 'done' | 'executing';
  }

  get publicStatus(): TerminalCardPublicStatus {
    return this.actor.getSnapshot().context.publicStatus;
  }

  snapshot() {
    const snapshot = this.actor.getSnapshot();
    return {
      actor_id: cardActorId(this.cardId),
      actor_kind: 'card' as const,
      state_value: snapshot.value,
      context: snapshot.context as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    saveActorSnapshot(this.actor.getSnapshot().context.projectRoot, this.snapshot());
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
