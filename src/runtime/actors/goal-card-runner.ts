import { assign, createActor, createMachine } from 'xstate';
import { buildXStateReviewerInput } from './actor-input-builders.js';
import { cardActorId, plannerActorId, reviewerActorId } from './ids.js';
import { LlmRunnerController } from './llm-runner.js';
import { saveActorSnapshot } from './snapshots.js';
import { appendToolDelivery } from './llm-delivery-log.js';
import { getActiveGoalNoteSinks } from './active-goal-note-sinks.js';
import type { AdmissionPort, LlmInvocationInput, ProviderTurnPort } from './llm-runner.js';
import type { XStateActorInputContext } from './actor-input-builders.js';
import type { XStateChildCard } from './xstate-child-activation.js';

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

export interface GoalCardStatusPort {
  markRunning(cardId: string): void | Promise<void>;
  markCancelled(cardId: string): void | Promise<void>;
  commitGoalOutcome(cardId: string, outcome: GoalOutcome): void | Promise<void>;
}

export interface GoalNote {
  id: string;
  content: string;
}

interface GoalCardRunnerContext {
  projectRoot: string;
  cardId: string;
  publicStatus: GoalCardPublicStatus;
  outcome: GoalOutcome | null;
}

type GoalCardRunnerEvent =
  | { type: 'START' }
  | { type: 'REVIEW_READY' }
  | { type: 'REVIEW_NEEDS_CORRECTIONS' }
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
        REVIEW_READY: { target: 'reviewing' },
        GOAL_OUTCOME: {
          target: 'done',
          actions: assign({ publicStatus: ({ event }) => event.outcome.status, outcome: ({ event }) => event.outcome }),
        },
        CANCEL: { target: 'done', actions: assign({ publicStatus: 'cancelled' }) },
      },
    },
    reviewing: {
      on: {
        REVIEW_NEEDS_CORRECTIONS: { target: 'planning' },
        GOAL_OUTCOME: {
          target: 'done',
          actions: assign({ publicStatus: ({ event }) => event.outcome.status, outcome: ({ event }) => event.outcome }),
        },
        CANCEL: { target: 'done', actions: assign({ publicStatus: 'cancelled' }) },
      },
    },
  },
});

export interface GoalCardRunnerOptions {
  admission?: AdmissionPort;
  reviewerProviderTurn?: ProviderTurnPort;
  publicStatus?: GoalCardPublicStatus;
  statusPort?: GoalCardStatusPort;
  card?: XStateChildCard;
  context?: XStateActorInputContext;
}

export class GoalCardRunnerController {
  private readonly actor;
  private readonly plannerRunner: LlmRunnerController;
  private readonly reviewerRunner: LlmRunnerController | null;
  private readonly pendingNotes: GoalNote[] = [];
  private readonly deliveredNoteIds = new Set<string>();
  private readonly card: XStateChildCard;
  private readonly inputContext?: XStateActorInputContext;

  constructor(
    projectRoot: string,
    readonly cardId: string,
    providerTurn: ProviderTurnPort,
    private readonly childActivation: ChildActivationPort,
    options: GoalCardRunnerOptions = {},
  ) {
    this.actor = createActor(goalCardRunnerMachine, { input: { projectRoot, cardId, publicStatus: options.publicStatus } });
    this.plannerRunner = new LlmRunnerController(projectRoot, plannerActorId(cardId), providerTurn, options.admission);
    this.reviewerRunner = options.reviewerProviderTurn
      ? new LlmRunnerController(projectRoot, reviewerActorId(cardId), options.reviewerProviderTurn, options.admission)
      : null;
    this.statusPort = options.statusPort;
    this.card = options.card ?? { id: cardId, type: 'goal' };
    this.inputContext = options.context;
    this.actor.start();
  }

  private readonly statusPort?: GoalCardStatusPort;

  async start(input: Omit<LlmInvocationInput, 'agentId'>): Promise<GoalOutcome> {
    this.actor.send({ type: 'START' });
    this.persist();
    await this.statusPort?.markRunning(this.cardId);
    const noteSinks = getActiveGoalNoteSinks(this.actor.getSnapshot().context.projectRoot);
    noteSinks.register(this.cardId, this);
    try {
      let currentInput = input;
      for (let turn = 0; turn < 20; turn++) {
        currentInput = this.deliverPendingNotes(currentInput);
        const output = await this.plannerRunner.runTurn({ ...currentInput, agentId: plannerActorId(this.cardId) });
        if (output.type === 'LLM_RESULT') {
          const review = await this.reviewPlannerResult(currentInput, output.result.content, turn);
          if (review.kind === 'passed') return this.complete({ status: 'done', statusText: output.result.content });
          if (review.kind === 'failed') return this.complete({ status: 'failed', statusText: review.reason });
          this.actor.send({ type: 'REVIEW_NEEDS_CORRECTIONS' });
          this.persist();
          currentInput = {
            ...currentInput,
            inputId: `${input.inputId}:review:${turn + 1}`,
            episodeContext: {
              ...currentInput.episodeContext,
              lastReviewResult: { result: 'needs_corrections', summary: review.summary },
            },
          };
          continue;
        }
        if (output.type === 'LLM_ERROR') return this.complete({ status: 'failed', statusText: output.error });
        if (output.toolName !== 'activate_card') return this.complete({ status: 'failed', statusText: `Unsupported planner tool call '${output.toolName}'.` });
        const childId = parseActivateCardArgs(output.args).cardId;
        const childOutcome = await this.childActivation.startChild(childId);
        const deliveryInputId = `${input.inputId}:child:${turn + 1}`;
        const deliveryResult = { cardId: childId, ...childOutcome };
        appendToolDelivery(this.actor.getSnapshot().context.projectRoot, {
          agent_id: plannerActorId(this.cardId),
          source_input_id: currentInput.inputId,
          delivery_input_id: deliveryInputId,
          tool_call_id: output.toolCallId,
          tool_name: output.toolName,
          result: deliveryResult,
        });
        currentInput = {
          ...currentInput,
          inputId: deliveryInputId,
          episodeContext: {
            ...currentInput.episodeContext,
            lastToolResult: {
              toolCallId: output.toolCallId,
              toolName: output.toolName,
              result: deliveryResult,
            },
          },
        };
        if (childOutcome.status !== 'done') return this.complete({ status: childOutcome.status, statusText: childOutcome.statusText });
      }
      return this.complete({ status: 'blocked', statusText: 'Planner exceeded the GoalCardRunner turn budget.' });
    } finally {
      noteSinks.unregister(this.cardId, this);
    }
  }

  get phase(): 'done' | 'planning' | 'reviewing' {
    return this.actor.getSnapshot().value as 'done' | 'planning' | 'reviewing';
  }

  get publicStatus(): GoalCardPublicStatus {
    return this.actor.getSnapshot().context.publicStatus;
  }

  addNote(note: GoalNote): void {
    if (this.pendingNotes.some((item) => item.id === note.id) || this.deliveredNoteIds.has(note.id)) return;
    this.pendingNotes.push(note);
    this.persist();
  }

  async cancel(): Promise<void> {
    this.actor.send({ type: 'CANCEL' });
    this.persist();
    await this.statusPort?.markCancelled(this.cardId);
  }

  snapshot() {
    const snapshot = this.actor.getSnapshot();
    return {
      actor_id: cardActorId(this.cardId),
      actor_kind: 'card' as const,
      state_value: snapshot.value,
      context: {
        ...(snapshot.context as unknown as Record<string, unknown>),
        noteBox: {
          pendingNoteIds: this.pendingNotes.map((note) => note.id),
          deliveredNoteIds: [...this.deliveredNoteIds].sort(),
        },
      },
      updated_at: new Date().toISOString(),
    };
  }

  private async complete(outcome: GoalOutcome): Promise<GoalOutcome> {
    this.actor.send({ type: 'GOAL_OUTCOME', outcome });
    this.persist();
    await this.statusPort?.commitGoalOutcome(this.cardId, outcome);
    return outcome;
  }

  private async reviewPlannerResult(input: Omit<LlmInvocationInput, 'agentId'>, plannerSummary: string, turn: number): Promise<
    | { kind: 'passed' }
    | { kind: 'needs_corrections'; summary: string }
    | { kind: 'failed'; reason: string }
  > {
    if (!this.reviewerRunner) return { kind: 'passed' };
    this.actor.send({ type: 'REVIEW_READY' });
    this.persist();
    const reviewerInput = buildXStateReviewerInput({
      inputId: `${input.inputId}:reviewer:${turn + 1}`,
      card: this.card,
      plannerSummary,
      context: this.inputContext,
    });
    const reviewerOutput = await this.reviewerRunner.runTurn({ ...reviewerInput, agentId: reviewerActorId(this.cardId) });
    if (reviewerOutput.type !== 'LLM_RESULT') {
      return { kind: 'failed', reason: reviewerOutput.type === 'LLM_ERROR' ? reviewerOutput.error : `Reviewer emitted unsupported tool call '${reviewerOutput.toolName}'.` };
    }
    const content = reviewerOutput.result.content.trim();
    if (content === 'pass') return { kind: 'passed' };
    if (content.startsWith('needs_corrections:')) return { kind: 'needs_corrections', summary: content.slice('needs_corrections:'.length).trim() };
    return { kind: 'failed', reason: `Reviewer returned unsupported result '${content}'.` };
  }

  private persist(): void {
    saveActorSnapshot(this.actor.getSnapshot().context.projectRoot, this.snapshot());
  }

  private deliverPendingNotes(input: Omit<LlmInvocationInput, 'agentId'>): Omit<LlmInvocationInput, 'agentId'> {
    const notes = this.pendingNotes.splice(0);
    if (notes.length === 0) return input;
    for (const note of notes) this.deliveredNoteIds.add(note.id);
    this.persist();
    return {
      ...input,
      episodeContext: {
        ...input.episodeContext,
        pendingNotes: notes,
        deliveredNoteIds: [...this.deliveredNoteIds].sort(),
      },
    };
  }
}

function parseActivateCardArgs(args: unknown): { cardId: string } {
  if (!args || typeof args !== 'object') throw new Error('activate_card args must be an object.');
  const cardId = (args as Record<string, unknown>).cardId;
  if (typeof cardId !== 'string' || cardId.length === 0) throw new Error('activate_card.cardId must be a non-empty string.');
  return { cardId };
}
