import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardRecord, PlannerBlockedResult, PlannerDoneResult, ReviewAssessment, ReviewerIssue, ReviewerPassResult } from '../../schemas/index.js';
import { nextReviewerAssessmentId, reviewerSessionId, validateReviewerAssessment } from '../reviewer-assessment.js';
import { LLMActor, type LLMAdmissionPort, type LLMProviderPort } from './llm-actor.js';
import { processorActorId, reviewerActorId } from './ids.js';
import { saveActorSnapshot } from './snapshots.js';
import type { CardActivationInput, CardActivationOutcome, CardActorStorePort, CardProcessorActor } from './card-actor.js';
import type { LlmInvocationInput } from './llm-invocation.js';

type ReviewerProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

type PendingActivation = {
  input: CardActivationInput;
  resolve: (outcome: ReviewerProcessorOutcome) => void;
  reject: (error: Error) => void;
};

export class ReviewerCardProcessorActor extends BaseActor implements CardProcessorActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { activate: 'reviewing', cancel: 'cancelled' } },
      reviewing: { on: { done: 'settled', blocked: 'settled', failed: 'settled', cancel: 'cancelled' } },
      settled: { parked: true, on: { activate: 'reviewing', cancel: 'cancelled' } },
      cancelled: { terminal: true },
    },
  };

  readonly projectRoot: string;
  readonly cardId: string;
  readonly store: CardActorStorePort;
  readonly provider: LLMProviderPort;
  readonly admission?: LLMAdmissionPort;
  outcome: ReviewerProcessorOutcome | null = null;
  cancelReason: string | null = null;
  #pending: PendingActivation | null = null;
  #activationCounter = 0;

  constructor(args: { projectRoot: string; cardId: string; store: CardActorStorePort; provider: LLMProviderPort; admission?: LLMAdmissionPort }) {
    super();
    this.projectRoot = args.projectRoot;
    this.cardId = args.cardId;
    this.store = args.store;
    this.provider = args.provider;
    this.admission = args.admission;
  }

  activate(input: CardActivationInput): Promise<ReviewerProcessorOutcome> {
    if (this.#pending) return Promise.reject(new Error(`Reviewer processor '${this.cardId}' already has a pending activation.`));
    if (this.state() !== 'idle' && this.state() !== 'settled') return Promise.reject(new Error(`Reviewer processor '${this.cardId}' cannot activate from '${this.state()}'.`));
    return new Promise<ReviewerProcessorOutcome>((resolve, reject) => {
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

  _on_enter__reviewing(): void {
    const pending = this.#pending;
    if (!pending) throw new Error(`Reviewer processor '${this.cardId}' entered reviewing without activation input.`);
    this.runTask((signal) => this.runActivation(pending.input, signal), {
      on_done: (outcome) => {
        this.outcome = outcome;
        pending.resolve(outcome);
        this.#pending = null;
        this.sendEvent(outcome.status);
      },
      on_failed: (error) => {
        const outcome: ReviewerProcessorOutcome = { status: 'failed', summary: error.message, result: { kind: 'planner_failure', error: error.message } };
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
      actor_id: processorActorId(`${this.cardId}:reviewer`),
      actor_kind: 'processor' as const,
      state_value: this.state(),
      context: { projectRoot: this.projectRoot, cardId: this.cardId, outcome: this.outcome, cancelReason: this.cancelReason },
      updated_at: new Date().toISOString(),
    };
  }

  private async runActivation(input: CardActivationInput, signal: AbortSignal): Promise<ReviewerProcessorOutcome> {
    const planning = plannerResult(input.card);
    if (!planning) return { status: 'failed', summary: `Card '${input.card.id}' has no planner result to review.`, result: { kind: 'planner_failure', error: `Card '${input.card.id}' has no planner result to review.` } };
    const assessmentId = nextReviewerAssessmentId(input.card.id, input.card.lifecycle.result);
    const sessionId = reviewerSessionId(input.card.id, assessmentId);
    const llm = new LLMActor({ projectRoot: this.projectRoot, agentId: reviewerActorId(input.card.id), provider: this.provider, admission: this.admission });
    llm.start();
    const outcome = await llm.turn(this.buildLlmInput(input, assessmentId, sessionId));
    if (signal.aborted) throw new Error('Reviewer activation cancelled.');
    if (outcome.type === 'error') return { status: 'failed', summary: outcome.error, result: { kind: 'planner_failure', error: outcome.error } };
    if (outcome.type === 'tool_call') return { status: 'failed', summary: 'Reviewer returned unsupported tool call.', result: { kind: 'planner_failure', error: 'Reviewer returned unsupported tool call.' } };
    return this.reviewOutcome(input.card, planning, assessmentId, sessionId, outcome.result.content);
  }

  private buildLlmInput(input: CardActivationInput, assessmentId: string, sessionId: string): LlmInvocationInput {
    this.#activationCounter++;
    return {
      inputId: `reviewer:${this.cardId}:${this.#activationCounter}`,
      agentId: reviewerActorId(this.cardId),
      role: 'reviewer',
      sessionId,
      systemPrompt: this.reviewerPrompt(input.card, assessmentId),
      contextMessages: input.notifications.map((notification) => ({ role: 'user', content: notification.message })),
      tools: [],
      terminalToolNames: [],
      modelParams: {},
      capabilityRequest: {},
      episodeContext: { cardId: input.card.id, caller: input.caller, assessmentId },
    };
  }

  private reviewOutcome(card: CardRecord, planning: PlannerDoneResult | PlannerBlockedResult, assessmentId: string, sessionId: string, content: string): ReviewerProcessorOutcome {
    const assessment = parseReviewAssessment(content, assessmentId, sessionId, card.id);
    const validation = validateReviewerAssessment({ goalId: card.id, assessment, readCard: (id) => this.store.read(id) });
    if (!validation.valid) return correctionOutcome(assessmentId, validation.reason ?? 'Reviewer assessment is invalid.');
    if (assessment.result === 'needs_corrections') return correctionOutcome(assessmentId, assessment.summary, assessment.issues.map((issue) => ({ ...issue })));
    const result: ReviewerPassResult = { kind: 'reviewer_pass', planning, review_summary: assessment.summary, assessment_id: assessmentId };
    return { status: 'done', summary: assessment.summary, result };
  }

  private reviewerPrompt(card: CardRecord, assessmentId: string): string {
    return `Review card ${card.id}: ${card.title}\n\n${card.description}\n\nAssessment id: ${assessmentId}\n\nReturn JSON only: {"result":"pass|needs_corrections","summary":"...","achieved":[],"issues":[],"evidence_card_ids":[]}.`;
  }

  private persist(): void {
    saveActorSnapshot(this.projectRoot, this.snapshot());
  }
}

function plannerResult(card: CardRecord): PlannerDoneResult | PlannerBlockedResult | null {
  const result = card.lifecycle.result;
  if (result?.kind === 'planner_done' || result?.kind === 'planner_blocked') return result;
  if (result?.kind === 'reviewer_pass') return result.planning;
  return null;
}

function correctionOutcome(assessmentId: string, summary: string, issues: Array<Record<string, unknown>> = []): ReviewerProcessorOutcome {
  return {
    status: 'blocked',
    summary,
    result: { kind: 'planner_blocked', blocked_reason: summary, resume_reason: 'reviewer_needs_corrections', reviewer_correction: { kind: 'reviewer_correction', assessment_id: assessmentId, summary, issues } },
  };
}

function parseReviewAssessment(content: string, assessmentId: string, sessionId: string, goalId: string): ReviewAssessment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Reviewer message must be JSON.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Reviewer message must be a JSON object.');
  const record = parsed as { result?: unknown; summary?: unknown; achieved?: unknown; issues?: unknown; evidence_card_ids?: unknown };
  if (record.result !== 'pass' && record.result !== 'needs_corrections') throw new Error('Reviewer result must be pass or needs_corrections.');
  if (typeof record.summary !== 'string' || record.summary.length === 0) throw new Error('Reviewer summary is required.');
  if (!Array.isArray(record.achieved) || !record.achieved.every((item) => typeof item === 'string')) throw new Error('Reviewer achieved must be an array of strings.');
  if (!Array.isArray(record.issues) || !record.issues.every(isReviewerIssue)) throw new Error('Reviewer issues must be valid issue objects.');
  if (!Array.isArray(record.evidence_card_ids) || !record.evidence_card_ids.every((item) => typeof item === 'string')) throw new Error('Reviewer evidence_card_ids must be an array of strings.');
  const now = new Date().toISOString();
  return { result: record.result, summary: record.summary, achieved: record.achieved, issues: record.issues, evidence_card_ids: record.evidence_card_ids, assessment_id: assessmentId, at: now, created_at: now, reviewer_session_id: sessionId, goal_card_id: goalId };
}

function isReviewerIssue(value: unknown): value is ReviewerIssue {
  if (!value || typeof value !== 'object') return false;
  const record = value as { summary?: unknown; severity?: unknown };
  return typeof record.summary === 'string' && (record.severity === undefined || record.severity === 'info' || record.severity === 'warning' || record.severity === 'blocker');
}
