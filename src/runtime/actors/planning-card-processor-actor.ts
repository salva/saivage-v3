import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardRecord, CardStatus, PlannerDoneResult } from '../../schemas/index.js';
import type { LLMActorOutcome, LLMAdmissionPort, LLMProviderPort } from './llm-actor.js';
import { plannerActorId, reviewerActorId } from './ids.js';
import { PLANNER_CARD_PROCESSOR_TOOL_DEFINITIONS } from './actor-tool-definitions.js';
import type { CardActivationInput, CardActivationOutcome, CardActor, CardActorStorePort, CardProcessorActor } from './card-actor.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { createPlannerContract, type PlannerTypedResult } from '../../contracts/planner-contract.js';
import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import { expectedTerminalToolMessage, verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import { nextReviewerAssessmentId, reviewerSessionId } from '../reviewer-assessment.js';
import { evaluateReviewerTerminalOutcome } from './reviewer-terminal-evaluation.js';

type PlannerProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

export interface PlannerChildActorPort {
  get(cardId: string): CardActor | null;
}

export class PlanningCardProcessorActor extends BaseMainLLMCardProcessorActor implements CardProcessorActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { activate: 'planning' } },
      planning: { on: { done: 'settled', failed: 'settled', blocked: 'settled' } },
      settled: { parked: true, on: { activate: 'planning' } },
    },
  };

  readonly store: CardActorStorePort;
  readonly children: PlannerChildActorPort;

  constructor(args: { projectRoot: string; cardId: string; store: CardActorStorePort; children: PlannerChildActorPort; provider: LLMProviderPort; admission?: LLMAdmissionPort }) {
    super(args);
    this.store = args.store;
    this.children = args.children;
  }

  _on_enter__planning(): void {
    this.runPendingActivation('planning', (input, signal) => this.runActivation(input, signal));
  }

  recoverTerminalToolOutcome(_input: CardActivationInput, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): PlannerProcessorOutcome | null {
    let typed: PlannerTypedResult;
    try {
      typed = verifyTerminalToolOutcome(createPlannerContract(), outcome).result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.plannerFailure(message);
    }
    const parsed = typed.result;
    if (parsed.status === 'done') return null;
    if (parsed.status === 'blocked') {
      const summary = parsed.summary ?? parsed.blocked_reason ?? 'Planner blocked.';
      return { status: 'blocked', summary, result: { kind: 'planner_blocked', blocked_reason: parsed.blocked_reason ?? summary, resume_reason: parsed.blocked_reason ?? summary } };
    }
    const summary = parsed.summary ?? 'Planner requested continuation without an action tool.';
    return { status: 'blocked', summary, result: { kind: 'planner_blocked', blocked_reason: summary, resume_reason: 'non_actionable_continue', blocker_cause: 'non_actionable_continue' } };
  }

  private async runActivation(input: CardActivationInput, signal: AbortSignal): Promise<PlannerProcessorOutcome> {
    const llm = this.createMainLlm(plannerActorId(this.cardId));
    let outcome = await llm.turn(this.buildLlmInput(input));
    for (let turn = 0; turn < 20; turn++) {
      if (signal.aborted) throw new Error('Planner activation cancelled.');
      if (outcome.type === 'result') return this.plannerFailure(`${expectedTerminalToolMessage(createPlannerContract())} Plain planner messages are not accepted as terminal results.`);
      if (outcome.type === 'error') return { status: 'failed', summary: outcome.error, result: { kind: 'planner_failure', error: outcome.error } };
      if (createPlannerContract().isTerminalToolName(outcome.toolName)) return this.projectPlannerTerminal(input, outcome, signal);
      const toolResult = await this.handleToolCall(input.card, outcome);
      outcome = await llm.appendToolResult(outcome.toolCallId, toolResult, (inputId) => this.notificationContextMessages(input, inputId));
    }
    return { status: 'failed', summary: 'Planner exceeded turn budget.', result: { kind: 'planner_failure', error: 'Planner exceeded turn budget.' } };
  }

  private buildLlmInput(input: CardActivationInput): LlmInvocationInput {
    const contract = createPlannerContract();
    const inputId = this.nextInvocationInputId('planner');
    return {
      inputId,
      agentId: plannerActorId(this.cardId),
      role: 'planner',
      sessionId: plannerActorId(this.cardId),
      systemPrompt: this.plannerPrompt(input.card),
      contextMessages: this.notificationContextMessages(input, inputId),
      tools: [...PLANNER_CARD_PROCESSOR_TOOL_DEFINITIONS, ...contract.terminals.map((terminal) => terminal.toolDefinition)],
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller, children: this.directChildren(input.card.id).map((card) => ({ id: card.id, status: card.status, type: card.type, title: card.title })) },
    };
  }

  private async handleToolCall(parent: CardRecord, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): Promise<unknown> {
    if (outcome.toolName !== 'activate_card') return { success: false, error: `Unsupported planner tool call '${outcome.toolName}'.` };
    const parsed = parseChildCardId(outcome.args);
    if (!parsed.success) return { success: false, error: parsed.error };
    const childId = parsed.cardId;
    const child = this.store.read(childId);
    if (!child) return { success: false, error: `Child card '${childId}' not found.` };
    if (child.parent !== parent.id) return { success: false, error: `Planner can activate only immediate children of '${parent.id}'.` };
    const actor = this.children.get(childId);
    if (!actor) return { success: false, error: `No CardActor is registered for child '${childId}'.` };
    try {
      const activation = await actor.activate({ kind: 'parent', cardId: parent.id, sessionId: plannerActorId(parent.id) });
      return { success: activation.status !== 'cancelled', card_id: childId, outcome: activation.status, summary: activation.summary, result: 'result' in activation ? activation.result : null };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), card_id: childId };
    }
  }

  private async projectPlannerTerminal(input: CardActivationInput, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, signal: AbortSignal): Promise<PlannerProcessorOutcome> {
    let typed: PlannerTypedResult;
    try {
      typed = verifyTerminalToolOutcome(createPlannerContract(), outcome).result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.plannerFailure(message);
    }
    const parsed = typed.result;
    if (parsed.status === 'done') {
      const blocker = firstIncompleteDescendant(this.cardId, this.store);
      if (blocker) return { status: 'blocked', summary: `Cannot complete while descendant '${blocker.id}' is ${blocker.status}.`, result: { kind: 'planner_blocked', blocked_reason: `Descendant '${blocker.id}' is ${blocker.status}.`, resume_reason: 'complete executable descendants before retrying' } };
      const summary = parsed.summary ?? 'Planner completed.';
      return this.reviewPlannerDone(input, { kind: 'planner_done', summary }, signal);
    }
    if (parsed.status === 'blocked') {
      const summary = parsed.summary ?? parsed.blocked_reason ?? 'Planner blocked.';
      return { status: 'blocked', summary, result: { kind: 'planner_blocked', blocked_reason: parsed.blocked_reason ?? summary, resume_reason: parsed.blocked_reason ?? summary } };
    }
    const summary = parsed.summary ?? 'Planner requested continuation without an action tool.';
    return { status: 'blocked', summary, result: { kind: 'planner_blocked', blocked_reason: summary, resume_reason: 'non_actionable_continue', blocker_cause: 'non_actionable_continue' } };
  }

  private async reviewPlannerDone(input: CardActivationInput, planning: PlannerDoneResult, signal: AbortSignal): Promise<PlannerProcessorOutcome> {
    const assessmentId = nextReviewerAssessmentId(input.card.id, input.card.lifecycle.result);
    const sessionId = reviewerSessionId(input.card.id, assessmentId);
    const llm = this.createMainLlm(reviewerActorId(input.card.id));
    const outcome = await llm.turn(this.buildReviewerLlmInput(input, assessmentId, sessionId));
    if (signal.aborted) throw new Error('Planner reviewer activation cancelled.');
    if (outcome.type === 'error') return { status: 'failed', summary: outcome.error, result: { kind: 'planner_failure', error: outcome.error } };
    if (outcome.type === 'result') return this.plannerFailure(`${expectedTerminalToolMessage(createReviewerContract())} Plain reviewer messages are not accepted as terminal results.`);
    if (!createReviewerContract().isTerminalToolName(outcome.toolName)) return this.plannerFailure(`Reviewer returned unsupported tool call '${outcome.toolName}'.`);
    const reviewed = evaluateReviewerTerminalOutcome({
      card: input.card,
      candidatePlanning: planning,
      assessmentId,
      sessionId,
      outcome,
      store: this.store,
    });
    if (reviewed.status === 'done' && input.notificationDelivery?.hasPendingNotifications?.()) return reviewerInvalidatedOutcome(assessmentId);
    return reviewed;
  }

  private buildReviewerLlmInput(input: CardActivationInput, assessmentId: string, sessionId: string): LlmInvocationInput {
    const contract = createReviewerContract();
    const inputId = this.nextInvocationInputId('reviewer');
    return {
      inputId,
      agentId: reviewerActorId(input.card.id),
      role: 'reviewer',
      sessionId,
      systemPrompt: this.reviewerPrompt(input.card, assessmentId),
      contextMessages: [],
      tools: contract.terminals.map((terminal) => terminal.toolDefinition),
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller, assessmentId },
    };
  }

  private plannerFailure(error: string): PlannerProcessorOutcome {
    return { status: 'failed', summary: error, result: { kind: 'planner_failure', error } };
  }

  private directChildren(cardId: string): CardRecord[] {
    return (this.store.listChildren?.(cardId) ?? []).map((id) => this.store.read(id)).filter((card): card is CardRecord => card !== null);
  }

  private plannerPrompt(card: CardRecord): string {
    return `Plan and coordinate card ${card.id}: ${card.title}\n\n${card.description}\n\nAcceptance:\n${card.acceptance}\n\nUse activate_card for immediate children only. End by calling emit_planner_result with status done, blocked, or continue; plain text or JSON messages are not accepted as terminal reports.`;
  }

  private reviewerPrompt(card: CardRecord, assessmentId: string): string {
    return `Review card ${card.id}: ${card.title}\n\n${card.description}\n\nAssessment id: ${assessmentId}\n\nEnd by calling emit_reviewer_result with the assessment envelope; plain text or JSON messages are not accepted as terminal reports.`;
  }

  protected get processorLabel(): string {
    return 'Planner processor';
  }

  protected get processorKind(): 'planning' {
    return 'planning';
  }

  protected activationFailureOutcome(error: string): PlannerProcessorOutcome {
    return { status: 'failed', summary: error, result: { kind: 'planner_failure', error } };
  }
}

function reviewerInvalidatedOutcome(assessmentId: string): PlannerProcessorOutcome {
  const summary = 'Reviewer approval invalidated by pending card notifications.';
  return { status: 'blocked', summary, result: { kind: 'planner_blocked', blocked_reason: summary, resume_reason: 'reviewer_invalidated_by_notifications', reviewer_correction: { kind: 'reviewer_correction', assessment_id: assessmentId, summary, issues: [{ summary }] } } };
}

function parseChildCardId(args: unknown): { success: true; cardId: string } | { success: false; error: string } {
  if (!args || typeof args !== 'object') return { success: false, error: 'activate_card requires an object argument.' };
  const maybe = args as { card_id?: unknown; cardId?: unknown; id?: unknown };
  const childId = maybe.card_id ?? maybe.cardId ?? maybe.id;
  if (typeof childId !== 'string' || childId.length === 0) return { success: false, error: 'activate_card requires card_id.' };
  return { success: true, cardId: childId };
}

function firstIncompleteDescendant(cardId: string, store: CardActorStorePort): { id: string; status: CardStatus } | null {
  for (const childId of store.listChildren?.(cardId) ?? []) {
    const child = store.read(childId);
    if (!child) continue;
    if (child.status !== 'done' && child.status !== 'cancelled') return { id: child.id, status: child.status };
    const descendant = firstIncompleteDescendant(childId, store);
    if (descendant) return descendant;
  }
  return null;
}
