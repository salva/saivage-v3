import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardRecord, CardStatus } from '../../schemas/index.js';
import type { LLMActorOutcome, LLMAdmissionPort, LLMProviderPort } from './llm-actor.js';
import { plannerActorId } from './ids.js';
import { XSTATE_PLANNER_TOOL_DEFINITIONS } from './actor-tool-definitions.js';
import type { CardActivationInput, CardActivationOutcome, CardActor, CardActorStorePort, CardProcessorActor } from './card-actor.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { createPlannerContract, type PlannerTypedResult } from '../../contracts/planner-contract.js';
import { expectedTerminalToolMessage, verifyTerminalToolOutcome } from './contract-terminal-tools.js';

type PlannerProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

export interface PlannerChildActorPort {
  get(cardId: string): CardActor | null;
}

export class PlannerCardProcessorActor extends BaseMainLLMCardProcessorActor implements CardProcessorActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { activate: 'planning', cancel: 'cancelled' } },
      planning: { on: { done: 'settled', failed: 'settled', blocked: 'settled', cancel: 'cancelled' } },
      settled: { parked: true, on: { activate: 'planning', cancel: 'cancelled' } },
      cancelled: { terminal: true },
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

  private async runActivation(input: CardActivationInput, signal: AbortSignal): Promise<PlannerProcessorOutcome> {
    const llm = this.createMainLlm(plannerActorId(this.cardId));
    let outcome = await llm.turn(this.buildLlmInput(input));
    for (let turn = 0; turn < 20; turn++) {
      if (signal.aborted) throw new Error('Planner activation cancelled.');
      if (outcome.type === 'result') return this.plannerFailure(`${expectedTerminalToolMessage(createPlannerContract())} Plain planner messages are not accepted as terminal results.`);
      if (outcome.type === 'error') return { status: 'failed', summary: outcome.error, result: { kind: 'planner_failure', error: outcome.error } };
      if (createPlannerContract().isTerminalToolName(outcome.toolName)) return this.projectPlannerTerminal(outcome);
      const toolResult = await this.handleToolCall(input.card, outcome);
      outcome = await llm.appendToolResult(outcome.toolCallId, toolResult);
    }
    return { status: 'failed', summary: 'Planner exceeded turn budget.', result: { kind: 'planner_failure', error: 'Planner exceeded turn budget.' } };
  }

  private buildLlmInput(input: CardActivationInput): LlmInvocationInput {
    const contract = createPlannerContract();
    return {
      inputId: this.nextInvocationInputId('planner'),
      agentId: plannerActorId(this.cardId),
      role: 'planner',
      sessionId: plannerActorId(this.cardId),
      systemPrompt: this.plannerPrompt(input.card),
      contextMessages: input.notifications.map((notification) => ({ role: 'user', content: notification.message })),
      tools: [...XSTATE_PLANNER_TOOL_DEFINITIONS, ...contract.terminals.map((terminal) => terminal.toolDefinition)],
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller, children: this.directChildren(input.card.id).map((card) => ({ id: card.id, status: card.status, type: card.type, title: card.title })) },
    };
  }

  private async handleToolCall(parent: CardRecord, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): Promise<unknown> {
    if (outcome.toolName !== 'activate_card') return { success: false, error: `Unsupported planner tool call '${outcome.toolName}'.` };
    const childId = parseChildCardId(outcome.args);
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

  private projectPlannerTerminal(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): PlannerProcessorOutcome {
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
      return { status: 'done', summary, result: { kind: 'planner_done', summary } };
    }
    if (parsed.status === 'blocked') {
      const summary = parsed.summary ?? parsed.blocked_reason ?? 'Planner blocked.';
      return { status: 'blocked', summary, result: { kind: 'planner_blocked', blocked_reason: parsed.blocked_reason ?? summary, resume_reason: parsed.blocked_reason ?? summary } };
    }
    const summary = parsed.summary ?? 'Planner requested continuation without an action tool.';
    return { status: 'blocked', summary, result: { kind: 'planner_blocked', blocked_reason: summary, resume_reason: 'non_actionable_continue', blocker_cause: 'non_actionable_continue' } };
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

  protected get processorLabel(): string {
    return 'Planner processor';
  }

  protected activationFailureOutcome(error: string): PlannerProcessorOutcome {
    return { status: 'failed', summary: error, result: { kind: 'planner_failure', error } };
  }
}

export class ProjectCardProcessorActor extends PlannerCardProcessorActor {}
export class GoalCardProcessorActor extends PlannerCardProcessorActor {}

function parseChildCardId(args: unknown): string {
  if (!args || typeof args !== 'object') throw new Error('activate_card requires an object argument.');
  const maybe = args as { card_id?: unknown; cardId?: unknown; id?: unknown };
  const childId = maybe.card_id ?? maybe.cardId ?? maybe.id;
  if (typeof childId !== 'string' || childId.length === 0) throw new Error('activate_card requires card_id.');
  return childId;
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
