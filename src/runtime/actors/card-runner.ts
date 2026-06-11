import { assign, createActor, createMachine } from 'xstate';
import type { LlmCompleteResult } from '../../agents/llm-contracts.js';
import { cardActorId, executorActorId } from './ids.js';
import { LlmRunnerController } from './llm-runner.js';
import { saveActorSnapshot } from './snapshots.js';
import type { LlmInvocationInput, ProviderTurnPort } from './llm-runner.js';

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

  constructor(
    projectRoot: string,
    readonly cardId: string,
    providerTurn: ProviderTurnPort,
    publicStatus: TerminalCardPublicStatus = 'backlog',
  ) {
    this.actor = createActor(terminalCardRunnerMachine, { input: { projectRoot, cardId, publicStatus } });
    this.llmRunner = new LlmRunnerController(projectRoot, executorActorId(cardId), providerTurn);
    this.actor.start();
  }

  async start(input: Omit<LlmInvocationInput, 'agentId'>): Promise<TerminalOutcome> {
    this.actor.send({ type: 'START' });
    this.persist();
    const output = await this.llmRunner.runTurn({ ...input, agentId: executorActorId(this.cardId) });
    if (output.type !== 'LLM_RESULT' || !output.result) {
      const outcome: TerminalOutcome = {
        status: 'failed',
        statusText: output.error ?? 'Executor failed without a terminal result.',
        result: { kind: 'message', content: output.error ?? 'executor failed' },
      };
      this.actor.send({ type: 'TERMINAL_OUTCOME', outcome });
      this.persist();
      return outcome;
    }
    const outcome: TerminalOutcome = { status: 'done', statusText: 'Executor completed.', result: output.result };
    this.actor.send({ type: 'TERMINAL_OUTCOME', outcome });
    this.persist();
    return outcome;
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
