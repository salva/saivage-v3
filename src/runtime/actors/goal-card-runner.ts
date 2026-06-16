import { buildXStateReviewerInput } from './actor-input-builders.js';
import { SlaveActor, startActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import { cardActorId, plannerActorId, reviewerActorId } from './ids.js';
import { LlmRunnerController } from './llm-runner.js';
import { saveActorSnapshot } from './snapshots.js';
import { appendToolCallStatus, appendToolDelivery } from './llm-delivery-log.js';
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

export interface GoalCardRunnerContext {
  projectRoot: string;
  cardId: string;
  publicStatus: GoalCardPublicStatus;
  outcome: GoalOutcome | null;
}

export class GoalCardRunnerActor extends SlaveActor {
  static _actor: ActorDefinition = {
    initial: 'done',
    states: {
      done: {
        on: { start: 'planning' },
        calls: { start: 'recordStart', cancel: false },
      },
      planning: {
        on: { review_ready: 'reviewing', done: 'done', failed: 'done', cancel: 'done' },
        calls: { review_ready: 'recordReviewReady', outcome: 'recordOutcome', cancel: 'recordCancel' },
      },
      reviewing: {
        on: { needs_corrections: 'planning', done: 'done', failed: 'done', cancel: 'done' },
        calls: { needs_corrections: 'recordNeedsCorrections', outcome: 'recordOutcome', cancel: 'recordCancel' },
      },
    },
  };

  outcome: GoalOutcome | null = null;

  constructor(
    readonly projectRoot: string,
    readonly cardId: string,
    publicStatus: GoalCardPublicStatus = 'backlog',
  ) {
    super();
    this.publicStatus = publicStatus;
  }

  publicStatus: GoalCardPublicStatus;

  recordStart(): void {
    this.publicStatus = 'running';
    this.outcome = null;
    this.send('start');
  }

  recordOutcome(outcome: GoalOutcome): void {
    this.publicStatus = outcome.status;
    this.outcome = outcome;
    this.send(outcome.status === 'done' ? 'done' : 'failed');
  }

  recordReviewReady(): void {
    this.send('review_ready');
  }

  recordNeedsCorrections(): void {
    this.send('needs_corrections');
  }

  recordCancel(): void {
    this.publicStatus = 'cancelled';
    this.send('cancel');
  }

  _on_enter__planning(): void {
    this.persist();
  }

  _on_enter__reviewing(): void {
    this.persist();
  }

  _on_enter__done(): void {
    this.persist();
  }

  context(): GoalCardRunnerContext {
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

export interface GoalCardRunnerOptions {
  admission?: AdmissionPort;
  reviewerProviderTurn?: ProviderTurnPort;
  publicStatus?: GoalCardPublicStatus;
  statusPort?: GoalCardStatusPort;
  card?: XStateChildCard;
  context?: XStateActorInputContext;
}

export class GoalCardRunnerController {
  private readonly actor: GoalCardRunnerActor;
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
    this.actor = startActor(GoalCardRunnerActor, projectRoot, cardId, options.publicStatus);
    this.plannerRunner = new LlmRunnerController(projectRoot, plannerActorId(cardId), providerTurn, options.admission);
    this.reviewerRunner = options.reviewerProviderTurn
      ? new LlmRunnerController(projectRoot, reviewerActorId(cardId), options.reviewerProviderTurn, options.admission)
      : null;
    this.statusPort = options.statusPort;
    this.card = options.card ?? { id: cardId, type: 'goal' };
    this.inputContext = options.context;
  }

  private readonly statusPort?: GoalCardStatusPort;

  async start(input: Omit<LlmInvocationInput, 'agentId'>): Promise<GoalOutcome> {
    this.actor.mailbox.deliver('start');
    await this.actor.waitForState((s) => s === 'planning');
    await this.statusPort?.markRunning(this.cardId);
    const noteSinks = getActiveGoalNoteSinks(this.actor.projectRoot);
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
          this.actor.mailbox.deliver('needs_corrections');
          await this.actor.waitForState((s) => s === 'planning');
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
        if (output.toolName !== 'activate_card') {
          const message = `Unsupported planner tool call '${output.toolName}'.`;
          this.recordToolError(currentInput.inputId, output.toolCallId, output.toolName, message);
          return this.complete({ status: 'failed', statusText: message });
        }
        let childId: string;
        let childOutcome: ChildActivationOutcome;
        try {
          childId = parseActivateCardArgs(output.args).cardId;
          childOutcome = await this.childActivation.startChild(childId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.recordToolError(currentInput.inputId, output.toolCallId, output.toolName, message);
          return this.complete({ status: 'failed', statusText: message });
        }
        const deliveryInputId = `${input.inputId}:child:${turn + 1}`;
        const deliveryResult = { cardId: childId, ...childOutcome };
        appendToolDelivery(this.actor.projectRoot, {
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
    return this.actor.state() as 'done' | 'planning' | 'reviewing';
  }

  get publicStatus(): GoalCardPublicStatus {
    return this.actor.publicStatus;
  }

  addNote(note: GoalNote): void {
    if (this.pendingNotes.some((item) => item.id === note.id) || this.deliveredNoteIds.has(note.id)) return;
    this.pendingNotes.push(note);
    this.persist();
  }

  async cancel(): Promise<void> {
    if (this.phase === 'done') return;
    this.actor.mailbox.deliver('cancel');
    await this.actor.waitForState((s) => s === 'done');
    await this.statusPort?.markCancelled(this.cardId);
  }

  snapshot() {
    return {
      actor_id: cardActorId(this.cardId),
      actor_kind: 'card' as const,
      state_value: this.actor.state(),
      context: {
        ...(this.actor.context() as unknown as Record<string, unknown>),
        noteBox: {
          pendingNoteIds: this.pendingNotes.map((note) => note.id),
          deliveredNoteIds: [...this.deliveredNoteIds].sort(),
        },
      },
      updated_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    saveActorSnapshot(this.actor.projectRoot, this.snapshot());
  }

  private async complete(outcome: GoalOutcome): Promise<GoalOutcome> {
    this.actor.mailbox.deliver('outcome', outcome);
    await this.actor.waitForState((s) => s === 'done');
    await this.statusPort?.commitGoalOutcome(this.cardId, outcome);
    this.persist();
    return outcome;
  }

  private recordToolError(sourceInputId: string, toolCallId: string, toolName: string, error: string): void {
    appendToolCallStatus(this.actor.projectRoot, {
      agent_id: plannerActorId(this.cardId),
      source_input_id: sourceInputId,
      tool_call_id: toolCallId,
      tool_name: toolName,
      status: 'errored',
      error,
    });
  }

  private async reviewPlannerResult(input: Omit<LlmInvocationInput, 'agentId'>, plannerSummary: string, turn: number): Promise<
    | { kind: 'passed' }
    | { kind: 'needs_corrections'; summary: string }
    | { kind: 'failed'; reason: string }
  > {
    if (!this.reviewerRunner) return { kind: 'passed' };
    this.actor.mailbox.deliver('review_ready');
    await this.actor.waitForState((s) => s === 'reviewing');
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

  private deliverPendingNotes(input: Omit<LlmInvocationInput, 'agentId'>): Omit<LlmInvocationInput, 'agentId'> {
    const notes = this.pendingNotes.splice(0);
    if (notes.length === 0) return input;
    for (const note of notes) this.deliveredNoteIds.add(note.id);
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
