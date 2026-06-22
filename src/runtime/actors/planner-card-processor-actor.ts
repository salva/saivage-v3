import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardRecord, CardStatus } from '../../schemas/index.js';
import { LLMActor, type LLMActorOutcome, type LLMAdmissionPort, type LLMProviderPort } from './llm-actor.js';
import { plannerActorId, processorActorId } from './ids.js';
import { XSTATE_PLANNER_TOOL_DEFINITIONS } from './actor-tool-definitions.js';
import { saveActorSnapshot } from './snapshots.js';
import type { CardActivationInput, CardActivationOutcome, CardActor, CardActorStorePort, CardProcessorActor } from './card-actor.js';
import type { LlmInvocationInput } from './llm-runner.js';

type PlannerProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

type PendingActivation = {
  input: CardActivationInput;
  resolve: (outcome: PlannerProcessorOutcome) => void;
  reject: (error: Error) => void;
};

export interface PlannerChildActorPort {
  get(cardId: string): CardActor | null;
}

export class PlannerCardProcessorActor extends BaseActor implements CardProcessorActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { activate: 'planning', cancel: 'cancelled' } },
      planning: { on: { done: 'settled', failed: 'settled', blocked: 'settled', cancel: 'cancelled' } },
      settled: { parked: true, on: { activate: 'planning', cancel: 'cancelled' } },
      cancelled: { terminal: true },
    },
  };

  readonly projectRoot: string;
  readonly cardId: string;
  readonly store: CardActorStorePort;
  readonly children: PlannerChildActorPort;
  readonly provider: LLMProviderPort;
  readonly admission?: LLMAdmissionPort;
  outcome: PlannerProcessorOutcome | null = null;
  cancelReason: string | null = null;
  #pending: PendingActivation | null = null;
  #activationCounter = 0;

  constructor(args: { projectRoot: string; cardId: string; store: CardActorStorePort; children: PlannerChildActorPort; provider: LLMProviderPort; admission?: LLMAdmissionPort }) {
    super();
    this.projectRoot = args.projectRoot;
    this.cardId = args.cardId;
    this.store = args.store;
    this.children = args.children;
    this.provider = args.provider;
    this.admission = args.admission;
  }

  activate(input: CardActivationInput): Promise<PlannerProcessorOutcome> {
    if (this.#pending) return Promise.reject(new Error(`Planner processor '${this.cardId}' already has a pending activation.`));
    if (this.state() !== 'idle' && this.state() !== 'settled') return Promise.reject(new Error(`Planner processor '${this.cardId}' cannot activate from '${this.state()}'.`));
    return new Promise<PlannerProcessorOutcome>((resolve, reject) => {
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

  _on_enter__planning(): void {
    const pending = this.#pending;
    if (!pending) throw new Error(`Planner processor '${this.cardId}' entered planning without activation input.`);
    this.runTask((signal) => this.runActivation(pending.input, signal), {
      on_done: (outcome) => {
        this.outcome = outcome;
        pending.resolve(outcome);
        this.#pending = null;
        this.sendEvent(outcome.status);
      },
      on_failed: (error) => {
        const outcome: PlannerProcessorOutcome = { status: 'failed', summary: error.message, result: { kind: 'planner_failure', error: error.message } };
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
      actor_id: processorActorId(this.cardId),
      actor_kind: 'processor' as const,
      state_value: this.state(),
      context: { projectRoot: this.projectRoot, cardId: this.cardId, outcome: this.outcome, cancelReason: this.cancelReason },
      updated_at: new Date().toISOString(),
    };
  }

  private async runActivation(input: CardActivationInput, signal: AbortSignal): Promise<PlannerProcessorOutcome> {
    const llm = new LLMActor({ projectRoot: this.projectRoot, agentId: plannerActorId(this.cardId), provider: this.provider, admission: this.admission });
    llm.start();
    let outcome = await llm.turn(this.buildLlmInput(input));
    for (let turn = 0; turn < 20; turn++) {
      if (signal.aborted) throw new Error('Planner activation cancelled.');
      if (outcome.type === 'result') return this.parsePlannerMessage(outcome.result.content);
      if (outcome.type === 'error') return { status: 'failed', summary: outcome.error, result: { kind: 'planner_failure', error: outcome.error } };
      const toolResult = await this.handleToolCall(input.card, outcome);
      outcome = await llm.appendToolResult(outcome.toolCallId, toolResult);
    }
    return { status: 'failed', summary: 'Planner exceeded turn budget.', result: { kind: 'planner_failure', error: 'Planner exceeded turn budget.' } };
  }

  private buildLlmInput(input: CardActivationInput): LlmInvocationInput {
    this.#activationCounter++;
    return {
      inputId: `planner:${this.cardId}:${this.#activationCounter}`,
      agentId: plannerActorId(this.cardId),
      role: 'planner',
      sessionId: plannerActorId(this.cardId),
      systemPrompt: this.plannerPrompt(input.card),
      contextMessages: input.notifications.map((notification) => ({ role: 'user', content: notification.message })),
      tools: XSTATE_PLANNER_TOOL_DEFINITIONS,
      terminalToolNames: [],
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

  private parsePlannerMessage(content: string): PlannerProcessorOutcome {
    const parsed = parsePlannerTerminal(content);
    if (parsed.status === 'done') {
      const blocker = firstIncompleteDescendant(this.cardId, this.store);
      if (blocker) return { status: 'blocked', summary: `Cannot complete while descendant '${blocker.id}' is ${blocker.status}.`, result: { kind: 'planner_blocked', blocked_reason: `Descendant '${blocker.id}' is ${blocker.status}.`, resume_reason: 'complete executable descendants before retrying' } };
      return { status: 'done', summary: parsed.summary, result: { kind: 'planner_done', summary: parsed.summary } };
    }
    if (parsed.status === 'blocked') return { status: 'blocked', summary: parsed.summary, result: { kind: 'planner_blocked', blocked_reason: parsed.summary, resume_reason: parsed.resume_reason ?? parsed.summary } };
    return { status: 'failed', summary: parsed.summary, result: { kind: 'planner_failure', error: parsed.summary } };
  }

  private directChildren(cardId: string): CardRecord[] {
    return (this.store.listChildren?.(cardId) ?? []).map((id) => this.store.read(id)).filter((card): card is CardRecord => card !== null);
  }

  private plannerPrompt(card: CardRecord): string {
    return `Plan and coordinate card ${card.id}: ${card.title}\n\n${card.description}\n\nAcceptance:\n${card.acceptance}\n\nReturn terminal reports as JSON: {"status":"done|blocked|failed","summary":"...","resume_reason":"..."}. Use activate_card for immediate children only.`;
  }

  private persist(): void {
    saveActorSnapshot(this.projectRoot, this.snapshot());
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

function parsePlannerTerminal(content: string): { status: 'done' | 'blocked' | 'failed'; summary: string; resume_reason?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Planner terminal message must be JSON.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Planner terminal message must be a JSON object.');
  const record = parsed as { status?: unknown; summary?: unknown; resume_reason?: unknown };
  if (record.status !== 'done' && record.status !== 'blocked' && record.status !== 'failed') throw new Error('Planner terminal status must be done, blocked, or failed.');
  if (typeof record.summary !== 'string' || record.summary.length === 0) throw new Error('Planner terminal summary is required.');
  return { status: record.status, summary: record.summary, resume_reason: typeof record.resume_reason === 'string' ? record.resume_reason : undefined };
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
