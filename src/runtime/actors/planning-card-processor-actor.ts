import type { ActorDefinition } from '../micro-actor/index.js';
import { cardTypeValues, urgencyValues, type CardRecord, type CardStatus, type CardType, type PlannerDoneResult, type Urgency } from '../../schemas/index.js';
import type { LLMActorOutcome, LLMAdmissionPort, LLMProviderPort } from './llm-actor.js';
import { plannerActorId, reviewerActorId } from './ids.js';
import { PLANNER_ACTOR_SURFACE_TOOL_DEFINITIONS, PLANNER_CARD_PROCESSOR_TOOL_DEFINITIONS } from './actor-tool-definitions.js';
import type { CardActivationInput, CardActivationOutcome, CardActor, CardActorStorePort, CardProcessorActor } from './card-actor.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { createPlannerContract, type PlannerTypedResult } from '../../contracts/planner-contract.js';
import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import { expectedTerminalToolMessage, verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import { nextReviewerAssessmentId, reviewerSessionId } from '../reviewer-assessment.js';
import { evaluateReviewerTerminalOutcome } from './reviewer-terminal-evaluation.js';
import { buildPlannerStateContextMessage } from '../../agents/planner-state-context.js';
import { ActorToolSurface } from './actor-tool-surface.js';
import type { NewCardInput } from '../../cards/store-api.js';

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
  readonly plannerToolSurface: ActorToolSurface;

  constructor(args: { projectRoot: string; cardId: string; store: CardActorStorePort; children: PlannerChildActorPort; provider: LLMProviderPort; admission?: LLMAdmissionPort }) {
    super(args);
    this.store = args.store;
    this.children = args.children;
    this.plannerToolSurface = this.createPlannerToolSurface();
  }

  _on_enter__planning(): void {
    this.runPendingActivation('planning', (input) => this.runActivation(input));
  }

  _on_recover__planning(): void {
    throw new Error(`Planning processor '${this.cardId}' cannot recover directly into active state 'planning'; startup recovery must project or restart the activation.`);
  }

  recoverTerminalToolOutcome(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): PlannerProcessorOutcome | null {
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

  private async runActivation(input: CardActivationInput): Promise<PlannerProcessorOutcome> {
    const contract = createPlannerContract();
    const llm = this.createMainLlm(plannerActorId(this.cardId));
    let outcome = await llm.turn(this.buildLlmInput(input, contract));
    while (true) {
      if (outcome.type === 'result') return this.plannerFailure(`${expectedTerminalToolMessage(contract)} Plain planner messages are not accepted as terminal results.`);
      if (outcome.type === 'error') return this.plannerFailure(outcome.error);
      if (contract.isTerminalToolName(outcome.toolName)) return this.projectPlannerTerminal(input, outcome, contract);
      const toolResult = await this.handleToolCall(input.card, outcome);
      outcome = await llm.appendToolResult(outcome.toolCallId, toolResult, (inputId) => this.notificationContextMessages(input, inputId));
    }
  }

  private buildLlmInput(input: CardActivationInput, contract = createPlannerContract()): LlmInvocationInput {
    const inputId = this.nextInvocationInputId('planner');
    return {
      inputId,
      agentId: plannerActorId(this.cardId),
      role: 'planner',
      sessionId: plannerActorId(this.cardId),
      systemPrompt: this.plannerPrompt(input.card),
      contextMessages: [
        buildPlannerStateContextMessage({
          projectRoot: this.projectRoot,
          sessionId: plannerActorId(this.cardId),
          goalId: this.cardId,
          cardStore: {
            read: (cardId) => this.store.read(cardId),
            listChildren: (cardId) => this.store.listChildren?.(cardId) ?? [],
          },
        }),
        ...this.notificationContextMessages(input, inputId),
      ],
      tools: [...PLANNER_CARD_PROCESSOR_TOOL_DEFINITIONS, ...contract.terminals.map((terminal) => terminal.toolDefinition)],
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller, children: this.directChildren(input.card.id).map((card) => ({ id: card.id, status: card.status, type: card.type, title: card.title })) },
    };
  }

  private async handleToolCall(parent: CardRecord, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): Promise<unknown> {
    if (this.plannerToolSurface.handles(outcome.toolName)) {
      try {
        return await this.plannerToolSurface.execute(outcome.toolName, outcome.args, { projectRoot: this.projectRoot, cardId: parent.id, sessionId: plannerActorId(parent.id) });
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
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

  private async projectPlannerTerminal(input: CardActivationInput, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, contract = createPlannerContract()): Promise<PlannerProcessorOutcome> {
    let typed: PlannerTypedResult;
    try {
      typed = verifyTerminalToolOutcome(contract, outcome).result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.plannerFailure(message);
    }
    const parsed = typed.result;
    if (parsed.status === 'done') {
      const blocker = firstIncompleteDescendant(this.cardId, this.store);
      if (blocker) return { status: 'blocked', summary: `Cannot complete while descendant '${blocker.id}' is ${blocker.status}.`, result: { kind: 'planner_blocked', blocked_reason: `Descendant '${blocker.id}' is ${blocker.status}.`, resume_reason: 'complete executable descendants before retrying' } };
      const summary = parsed.summary ?? 'Planner completed.';
      return this.reviewPlannerDone(input, { kind: 'planner_done', summary });
    }
    if (parsed.status === 'blocked') {
      const summary = parsed.summary ?? parsed.blocked_reason ?? 'Planner blocked.';
      return { status: 'blocked', summary, result: { kind: 'planner_blocked', blocked_reason: parsed.blocked_reason ?? summary, resume_reason: parsed.blocked_reason ?? summary } };
    }
    const summary = parsed.summary ?? 'Planner requested continuation without an action tool.';
    return { status: 'blocked', summary, result: { kind: 'planner_blocked', blocked_reason: summary, resume_reason: 'non_actionable_continue', blocker_cause: 'non_actionable_continue' } };
  }

  private async reviewPlannerDone(input: CardActivationInput, planning: PlannerDoneResult): Promise<PlannerProcessorOutcome> {
    const assessmentId = nextReviewerAssessmentId(input.card.id, input.card.lifecycle.result);
    const sessionId = reviewerSessionId(input.card.id, assessmentId);
    const llm = this.createMainLlm(reviewerActorId(input.card.id));
    const outcome = await llm.turn(this.buildReviewerLlmInput(input, assessmentId, sessionId));
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
    return `Plan and coordinate card ${card.id}: ${card.title}\n\n${card.description}\n\nAcceptance:\n${card.acceptance}\n\nUse create_card for immediate children of this card. create_card creates a backlog child but does not run it. Use activate_card for immediate children only when work should execute. If this goal is incomplete and no existing child can make progress, create the next useful immediate child card instead of reporting blocked. End by calling emit_planner_result with status done, blocked, or continue; plain text or JSON messages are not accepted as terminal reports.`;
  }

  private reviewerPrompt(card: CardRecord, assessmentId: string): string {
    return `Review card ${card.id}: ${card.title}\n\n${card.description}\n\nAcceptance:\n${card.acceptance}\n\nAssessment id: ${assessmentId}\n\nEnd by calling emit_reviewer_result with the assessment envelope; plain text or JSON messages are not accepted as terminal reports.`;
  }

  private createPlannerToolSurface(): ActorToolSurface {
    const definitions = new Map(PLANNER_ACTOR_SURFACE_TOOL_DEFINITIONS.map((definition) => [definition.function.name, definition]));
    return new ActorToolSurface([
      {
        name: 'create_card',
        definition: requiredDefinition(definitions, 'create_card'),
        execute: (args) => this.handleCreateCard(args),
      },
    ]);
  }

  private handleCreateCard(args: unknown): unknown {
    const record = requireRecordArgs(args, 'create_card');
    const type = requirePlannerCreatedType(record.type);
    const status = optionalString(record.status, 'status');
    if (status !== undefined && status !== 'backlog') throw new Error('create_card.status may only be backlog for planner-created child cards.');
    const dependsOn = optionalStringArray(record.depends_on, 'depends_on');
    this.assertImmediateChildDependencies(dependsOn);
    const input: NewCardInput = {
      type,
      parent: this.cardId,
      depth: 0,
      title: requireNonEmptyString(record.title, 'title'),
      description: optionalString(record.description, 'description') ?? '',
      status: 'backlog',
      tags: optionalStringArray(record.tags, 'tags'),
      priority: optionalInteger(record.priority, 'priority') ?? 0,
      urgency: optionalUrgency(record.urgency),
      created_by: 'planner',
      acceptance: optionalString(record.acceptance, 'acceptance') ?? '',
      depends_on: dependsOn,
      related: optionalStringArray(record.related, 'related'),
      artifacts: [],
      attachments: [],
      retries: 0,
    };
    if (!this.store.create) throw new Error('Planner create_card requires a mutable card store.');
    const card = this.store.create(input);
    return { success: true, card: compactPlannerToolCard(card) };
  }

  private assertImmediateChildDependencies(dependsOn: string[]): void {
    for (const dependencyId of dependsOn) {
      const dependency = this.store.read(dependencyId);
      if (!dependency) throw new Error(`Dependency card '${dependencyId}' not found.`);
      if (dependency.parent !== this.cardId) throw new Error(`Dependency '${dependencyId}' must be an immediate child of '${this.cardId}'.`);
    }
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
    const maybe = args as { card_id?: unknown };
    const childId = maybe.card_id;
  if (typeof childId !== 'string' || childId.length === 0) return { success: false, error: 'activate_card requires card_id.' };
  return { success: true, cardId: childId };
}

function requiredDefinition(definitions: Map<string, (typeof PLANNER_ACTOR_SURFACE_TOOL_DEFINITIONS)[number]>, name: string): (typeof PLANNER_ACTOR_SURFACE_TOOL_DEFINITIONS)[number] {
  const definition = definitions.get(name);
  if (!definition) throw new Error(`Missing planner actor tool definition '${name}'.`);
  return definition;
}

function requireRecordArgs(args: unknown, toolName: string): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${toolName} requires an object argument.`);
  return args as Record<string, unknown>;
}

function requirePlannerCreatedType(value: unknown): Exclude<CardType, 'project'> {
  if (typeof value !== 'string' || !cardTypeValues.includes(value as CardType)) throw new Error(`create_card.type must be one of: ${cardTypeValues.filter((type) => type !== 'project').join(', ')}.`);
  if (value === 'project') throw new Error('create_card cannot create project cards.');
  return value as Exclude<CardType, 'project'>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (parsed.trim().length === 0) throw new Error(`${field} must be a non-empty string.`);
  return parsed;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${field} must be an array of strings.`);
  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer.`);
  return value as number;
}

function requireUrgency(value: unknown): Urgency {
  if (typeof value !== 'string' || !urgencyValues.includes(value as Urgency)) throw new Error(`urgency must be one of: ${urgencyValues.join(', ')}.`);
  return value as Urgency;
}

function optionalUrgency(value: unknown): Urgency {
  if (value === undefined || value === null) return 'normal';
  return requireUrgency(value);
}

function compactPlannerToolCard(card: CardRecord): Pick<CardRecord, 'id' | 'type' | 'parent' | 'status' | 'title' | 'description' | 'acceptance' | 'depends_on' | 'related' | 'tags' | 'priority' | 'urgency'> {
  return {
    id: card.id,
    type: card.type,
    parent: card.parent,
    status: card.status,
    title: card.title,
    description: card.description,
    acceptance: card.acceptance,
    depends_on: card.depends_on,
    related: card.related,
    tags: card.tags,
    priority: card.priority,
    urgency: card.urgency,
  };
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
