import { assign, createActor, createMachine } from 'xstate';
import { cardActorId, plannerActorId, reviewerActorId } from './ids.js';
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
}

export class GoalCardRunnerController {
  private readonly actor;
  private readonly plannerRunner: LlmRunnerController;
  private readonly reviewerRunner: LlmRunnerController | null;
  private readonly pendingNotes: GoalNote[] = [];
  private readonly deliveredNoteIds = new Set<string>();

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
    this.actor.start();
  }

  async start(input: Omit<LlmInvocationInput, 'agentId'>): Promise<GoalOutcome> {
    this.actor.send({ type: 'START' });
    this.persist();
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

  private complete(outcome: GoalOutcome): GoalOutcome {
    this.actor.send({ type: 'GOAL_OUTCOME', outcome });
    this.persist();
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
    const reviewerOutput = await this.reviewerRunner.runTurn({
      ...input,
      inputId: `${input.inputId}:reviewer:${turn + 1}`,
      agentId: reviewerActorId(this.cardId),
      role: 'reviewer',
      sessionId: reviewerActorId(this.cardId),
      episodeContext: { ...input.episodeContext, plannerSummary },
    });
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
