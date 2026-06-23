import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardRecord, PlannerBlockedResult, PlannerDoneResult } from '../../schemas/index.js';
import { nextReviewerAssessmentId, reviewerSessionId } from '../reviewer-assessment.js';
import type { LLMActorOutcome, LLMAdmissionPort, LLMProviderPort } from './llm-actor.js';
import { processorActorId, reviewerActorId } from './ids.js';
import type { CardActivationInput, CardActivationOutcome, CardActorStorePort, CardProcessorActor } from './card-actor.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import { expectedTerminalToolMessage } from './contract-terminal-tools.js';
import { evaluateReviewerTerminalOutcome } from './reviewer-terminal-evaluation.js';

type ReviewerProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

export class ReviewerCardProcessorActor extends BaseMainLLMCardProcessorActor implements CardProcessorActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { activate: 'reviewing', cancel: 'cancelled' } },
      reviewing: { on: { done: 'settled', blocked: 'settled', failed: 'settled', cancel: 'cancelled' } },
      settled: { parked: true, on: { activate: 'reviewing', cancel: 'cancelled' } },
      cancelled: { terminal: true },
    },
  };

  readonly store: CardActorStorePort;

  constructor(args: { projectRoot: string; cardId: string; store: CardActorStorePort; provider: LLMProviderPort; admission?: LLMAdmissionPort }) {
    super(args);
    this.store = args.store;
  }

  _on_enter__reviewing(): void {
    this.runPendingActivation('reviewing', (input, signal) => this.runActivation(input, signal));
  }

  protected override processorSnapshotId(): string {
    return processorActorId(`${this.cardId}:reviewer`);
  }

  private async runActivation(input: CardActivationInput, signal: AbortSignal): Promise<ReviewerProcessorOutcome> {
    const planning = plannerResult(input.card);
    if (!planning) return { status: 'failed', summary: `Card '${input.card.id}' has no planner result to review.`, result: { kind: 'planner_failure', error: `Card '${input.card.id}' has no planner result to review.` } };
    const assessmentId = nextReviewerAssessmentId(input.card.id, input.card.lifecycle.result);
    const sessionId = reviewerSessionId(input.card.id, assessmentId);
    const llm = this.createMainLlm(reviewerActorId(input.card.id));
    const outcome = await llm.turn(this.buildLlmInput(input, assessmentId, sessionId));
    if (signal.aborted) throw new Error('Reviewer activation cancelled.');
    if (outcome.type === 'error') return { status: 'failed', summary: outcome.error, result: { kind: 'planner_failure', error: outcome.error } };
    if (outcome.type === 'result') return { status: 'failed', summary: `${expectedTerminalToolMessage(createReviewerContract())} Plain reviewer messages are not accepted as terminal results.`, result: { kind: 'planner_failure', error: `${expectedTerminalToolMessage(createReviewerContract())} Plain reviewer messages are not accepted as terminal results.` } };
    if (!createReviewerContract().isTerminalToolName(outcome.toolName)) return { status: 'failed', summary: `Reviewer returned unsupported tool call '${outcome.toolName}'.`, result: { kind: 'planner_failure', error: `Reviewer returned unsupported tool call '${outcome.toolName}'.` } };
    return this.reviewOutcome(input.card, planning, assessmentId, sessionId, outcome);
  }

  private buildLlmInput(input: CardActivationInput, assessmentId: string, sessionId: string): LlmInvocationInput {
    const contract = createReviewerContract();
    const inputId = this.nextInvocationInputId('reviewer');
    return {
      inputId,
      agentId: reviewerActorId(this.cardId),
      role: 'reviewer',
      sessionId,
      systemPrompt: this.reviewerPrompt(input.card, assessmentId),
      contextMessages: this.notificationContextMessages(input, inputId),
      tools: contract.terminals.map((terminal) => terminal.toolDefinition),
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller, assessmentId },
    };
  }

  private reviewOutcome(card: CardRecord, planning: PlannerDoneResult | PlannerBlockedResult, assessmentId: string, sessionId: string, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): ReviewerProcessorOutcome {
    return evaluateReviewerTerminalOutcome({ card, planning, assessmentId, sessionId, outcome, store: this.store });
  }

  private reviewerPrompt(card: CardRecord, assessmentId: string): string {
    return `Review card ${card.id}: ${card.title}\n\n${card.description}\n\nAssessment id: ${assessmentId}\n\nEnd by calling emit_reviewer_result with the assessment envelope; plain text or JSON messages are not accepted as terminal reports.`;
  }

  protected get processorLabel(): string {
    return 'Reviewer processor';
  }

  protected activationFailureOutcome(error: string): ReviewerProcessorOutcome {
    return { status: 'failed', summary: error, result: { kind: 'planner_failure', error } };
  }
}

function plannerResult(card: CardRecord): PlannerDoneResult | PlannerBlockedResult | null {
  const result = card.lifecycle.result;
  if (result?.kind === 'planner_done' || result?.kind === 'planner_blocked') return result;
  if (result?.kind === 'reviewer_pass') return result.planning;
  return null;
}
