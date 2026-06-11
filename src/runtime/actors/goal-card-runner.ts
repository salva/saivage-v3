import { assign, createActor, createMachine } from 'xstate';
import { cardActorId, plannerActorId } from './ids.js';
import { LlmRunnerController } from './llm-runner.js';
import { saveActorSnapshot } from './snapshots.js';
import type { AdmissionPort, LlmInvocationInput, ProviderTurnPort } from './llm-runner.js';

export type GoalCardPublicStatus = 'backlog' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';

export interface ChildActivationOutcome {
  status: 'done' | 'failed' | 'blocked' | 'cancelled';
  statusText: string;
}

export interface ChildActivationPort {
  startChild(cardId: string): Promise<ChildActivationOutcome>;
}

export interface GoalOutcome {
  status: Exclude<GoalCardPublicStatus, 'backlog' | 'running'>;
  statusText: string;
}

interface GoalCardRunnerContext {
  projectRoot: string;
  cardId: string;
  publicStatus: GoalCardPublicStatus;
  outcome: GoalOutcome | null;
}

type GoalCardRunnerEvent =
  | { type: 'START' }
  | { type: 'GOAL_OUTCOME'; outcome: GoalOutcome }
  | { type: 'CANCEL' };

const goalCardRunnerMachine = createMachine({
  types: {} as {
    context: GoalCardRunnerContext;
    events: GoalCardRunnerEvent;
  },
  id: 'goalCardRunner',
  initial: 'done',
  context: ({ input }: { input: { projectRoot: string; cardId: string; publicStatus?: GoalCardPublicStatus } }) => ({
    projectRoot: input.projectRoot,
    cardId: input.cardId,
    publicStatus: input.publicStatus ?? 'backlog',
    outcome: null,
  }),
  states: {
    done: {
      on: {
        START: { target: 'planning', actions: assign({ publicStatus: 'running', outcome: null }) },
        CANCEL: { actions: assign({ publicStatus: 'cancelled' }) },
      },
    },
    planning: {
      on: {
        GOAL_OUTCOME: {
          target: 'done',
          actions: assign({ publicStatus: ({ event }) => event.outcome.status, outcome: ({ event }) => event.outcome }),
        },
        CANCEL: { target: 'done', actions: assign({ publicStatus: 'cancelled' }) },
      },
    },
  },
});

export class GoalCardRunnerController {
  private readonly actor;
  private readonly plannerRunner: LlmRunnerController;

  constructor(
    projectRoot: string,
    readonly cardId: string,
    providerTurn: ProviderTurnPort,
    private readonly childActivation: ChildActivationPort,
    admission?: AdmissionPort,
    publicStatus: GoalCardPublicStatus = 'backlog',
  ) {
    this.actor = createActor(goalCardRunnerMachine, { input: { projectRoot, cardId, publicStatus } });
    this.plannerRunner = new LlmRunnerController(projectRoot, plannerActorId(cardId), providerTurn, admission);
    this.actor.start();
  }

  async start(input: Omit<LlmInvocationInput, 'agentId'>): Promise<GoalOutcome> {
    this.actor.send({ type: 'START' });
    this.persist();
    let currentInput = input;
    for (let turn = 0; turn < 20; turn++) {
      const output = await this.plannerRunner.runTurn({ ...currentInput, agentId: plannerActorId(this.cardId) });
      if (output.type === 'LLM_RESULT') return this.complete({ status: 'done', statusText: output.result.content });
      if (output.type === 'LLM_ERROR') return this.complete({ status: 'failed', statusText: output.error });
      if (output.toolName !== 'activate_card') return this.complete({ status: 'failed', statusText: `Unsupported planner tool call '${output.toolName}'.` });
      const childId = parseActivateCardArgs(output.args).cardId;
      const childOutcome = await this.childActivation.startChild(childId);
      currentInput = {
        ...currentInput,
        inputId: `${input.inputId}:child:${turn + 1}`,
        episodeContext: {
          ...currentInput.episodeContext,
          lastToolResult: {
            toolCallId: output.toolCallId,
            toolName: output.toolName,
            result: { cardId: childId, ...childOutcome },
          },
        },
      };
      if (childOutcome.status !== 'done') return this.complete({ status: childOutcome.status, statusText: childOutcome.statusText });
    }
    return this.complete({ status: 'blocked', statusText: 'Planner exceeded the GoalCardRunner turn budget.' });
  }

  get phase(): 'done' | 'planning' {
    return this.actor.getSnapshot().value as 'done' | 'planning';
  }

  get publicStatus(): GoalCardPublicStatus {
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

  private complete(outcome: GoalOutcome): GoalOutcome {
    this.actor.send({ type: 'GOAL_OUTCOME', outcome });
    this.persist();
    return outcome;
  }

  private persist(): void {
    saveActorSnapshot(this.actor.getSnapshot().context.projectRoot, this.snapshot());
  }
}

function parseActivateCardArgs(args: unknown): { cardId: string } {
  if (!args || typeof args !== 'object') throw new Error('activate_card args must be an object.');
  const cardId = (args as Record<string, unknown>).cardId;
  if (typeof cardId !== 'string' || cardId.length === 0) throw new Error('activate_card.cardId must be a non-empty string.');
  return { cardId };
}
