import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardRecord, CardStatus, DoneResult } from '../../schemas/index.js';
import type { LLMActorOutcome, LLMAdmissionPort, LLMProviderPort } from './llm-actor.js';
import { plannerActorId, reviewerActorId } from './ids.js';
import type { CardActivationInput, CardActivationOutcome, CardActor, CardActorStorePort, CardProcessorActor } from './card-actor.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { createPlannerContract, type PlannerTypedResult } from '../../contracts/planner-contract.js';
import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import { expectedTerminalToolMessage, verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import { nextReviewerAssessmentId, reviewerSessionId } from '../reviewer-assessment.js';
import { evaluateReviewerTerminalOutcome } from './reviewer-terminal-evaluation.js';
import { buildPlannerStateContextMessage } from '../../agents/planner-state-context.js';
import { buildInvocationSurface, invokeTool, surfaceToolDefinitions } from '../../tools/invocation.js';
import { createCardHistoryProvider } from '../../tools/card-history-provider.js';
import { createCardInspectionProvider } from '../../tools/card-inspection-provider.js';
import { createPlannerControlProvider } from '../../tools/planner-control-provider.js';
import { createWorkspaceProvider } from '../../tools/workspace-provider.js';
import { createSkillProvider } from '../../tools/skill-provider.js';
import { createMcpProvider } from '../../tools/mcp-provider.js';
import { createWebProvider } from '../../tools/web-tools.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import { closeOpenRecordSlot, concreteRecordSlot, discardOpenRecordSlot, latestClosedRecordSlot, readRecordSlotIndex, recordFileIsNonEmpty } from '../records/record-slots.js';
import { cardBriefForPrompt } from '../records/card-brief.js';

type PlannerProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;
const MAX_TERMINAL_CONTRACT_REPAIRS = 2;

type ReviewerCurrentnessSnapshot = {
  cards: Array<{ id: string; status: CardStatus; versionSeq: number }>;
  includedRecordVersions: Array<{ cardId: string; filename: 'status.md'; latest: number | null }>;
  hasPendingNotifications: boolean;
};

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

  private readonly mcpManagerProvider: () => McpToolInvocationPort | undefined;

  constructor(args: { projectRoot: string; cardId: string; store: CardActorStorePort; children: PlannerChildActorPort; provider: LLMProviderPort; admission?: LLMAdmissionPort; mcpManagerProvider?: () => McpToolInvocationPort | undefined }) {
    super(args);
    this.store = args.store;
    this.children = args.children;
    this.mcpManagerProvider = args.mcpManagerProvider ?? (() => undefined);
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
      const summary = parsed.summary;
      return { status: 'blocked', summary, result: { kind: 'blocked', summary, resume_reason: summary } };
    }
    return { status: 'failed', summary: parsed.summary, result: { kind: 'failed', summary: parsed.summary } };
  }

  private async runActivation(input: CardActivationInput): Promise<PlannerProcessorOutcome> {
    const contract = createPlannerContract();
    const llm = this.createMainLlm(plannerActorId(this.cardId));
    discardOpenRecordSlot(this.projectRoot, { cardId: input.card.id, filename: 'status.md', reason: 'new_activation' });
    let outcome = await llm.turn(this.buildLlmInput(input, contract));
    let repairAttempts = 0;
    while (true) {
      if (outcome.type === 'result') {
        const message = `${expectedTerminalToolMessage(contract)} Plain planner messages are not accepted as terminal results.`;
        if (repairAttempts >= MAX_TERMINAL_CONTRACT_REPAIRS) return this.plannerFailure(message);
        repairAttempts++;
        outcome = await llm.continueAfterPlainText(`${message} Use tools. Write record://status.md?v=next if needed, then call emit_result with valid JSON arguments.`);
        continue;
      }
      if (outcome.type === 'error') return this.plannerFailure(outcome.error);
      if (contract.isTerminalToolName(outcome.toolName)) {
        const invalidTerminal = this.validatePlannerTerminal(outcome, contract);
        if (invalidTerminal) {
          if (repairAttempts >= MAX_TERMINAL_CONTRACT_REPAIRS) return this.plannerFailure(invalidTerminal);
          repairAttempts++;
          outcome = await llm.appendToolResult(outcome.toolCallId, { success: false, error: invalidTerminal }, () => [{ role: 'user', content: `${invalidTerminal} Call emit_result again with valid JSON arguments.` }]);
          continue;
        }
        const missingRecord = this.closeRequiredRecord(input.card.id, 'status.md', 'planner', input.card.version_seq);
        if (missingRecord) {
          if (repairAttempts >= MAX_TERMINAL_CONTRACT_REPAIRS) return this.plannerFailure(missingRecord);
          repairAttempts++;
          outcome = await llm.appendToolResult(outcome.toolCallId, { success: false, error: missingRecord }, () => [{ role: 'user', content: `${missingRecord} Create record://status.md?v=next, then call emit_result again.` }]);
          continue;
        }
        return this.projectPlannerTerminal(input, outcome, contract);
      }
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
      tools: [...surfaceToolDefinitions(this.plannerInvocationSurface(input.card.id)), ...contract.terminals.map((terminal) => terminal.toolDefinition)],
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller, children: this.directChildren(input.card.id).map((card) => ({ id: card.id, status: card.status, type: card.type, title: card.title })) },
    };
  }

  private async handleToolCall(parent: CardRecord, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): Promise<unknown> {
    const surface = this.plannerInvocationSurface(parent.id);
    if (!surface.tools.has(outcome.toolName)) return { success: false, error: `Unsupported planner tool call '${outcome.toolName}'.` };
    return invokeTool(surface, outcome.toolName, outcome.args);
  }

  private plannerInvocationSurface(parentCardId: string) {
    return buildInvocationSurface('planner', [
      createPlannerControlProvider({ projectRoot: this.projectRoot, parentCardId, sessionId: plannerActorId(parentCardId), store: this.store, children: this.children }),
      createCardInspectionProvider({ projectRoot: this.projectRoot, store: this.store, agentRole: 'planner' }),
      createWorkspaceProvider({ projectRoot: this.projectRoot, cardId: parentCardId, agentRole: 'planner' }),
      createCardHistoryProvider({ projectRoot: this.projectRoot, sessionId: plannerActorId(parentCardId), agentRole: 'planner' }),
      createWebProvider({ projectRoot: this.projectRoot, cardId: parentCardId, agentRole: 'planner' }),
    ]);
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
      if (blocker) return { status: 'blocked', summary: `Cannot complete while descendant '${blocker.id}' is ${blocker.status}.`, result: { kind: 'blocked', summary: `Descendant '${blocker.id}' is ${blocker.status}.`, resume_reason: 'complete executable descendants before retrying' } };
      const summary = parsed.summary;
      return this.reviewPlannerDone(input, { kind: 'done', summary });
    }
    if (parsed.status === 'blocked') {
      const summary = parsed.summary;
      return { status: 'blocked', summary, result: { kind: 'blocked', summary, resume_reason: summary } };
    }
    return { status: 'failed', summary: parsed.summary, result: { kind: 'failed', summary: parsed.summary } };
  }

  private async reviewPlannerDone(input: CardActivationInput, planning: DoneResult): Promise<PlannerProcessorOutcome> {
    if (this.directChildren(input.card.id).length === 0) return { status: 'done', summary: planning.summary, result: planning };
    const assessmentId = nextReviewerAssessmentId(input.card.id, input.card.lifecycle.result);
    const sessionId = reviewerSessionId(input.card.id, assessmentId);
    const llm = this.createMainLlm(reviewerActorId(input.card.id));
    const reviewerContract = createReviewerContract();
    discardOpenRecordSlot(this.projectRoot, { cardId: input.card.id, filename: 'review.md', reason: 'new_reviewer_activation' });
    let reviewerRelaunchAttempts = 0;
    while (true) {
      const currentness = this.captureReviewerCurrentness(input);
      let outcome = await llm.turn(this.buildReviewerLlmInput(input, assessmentId, sessionId, currentness));
      let repairAttempts = 0;
      while (true) {
        if (outcome.type === 'error') return { status: 'failed', summary: outcome.error, result: { kind: 'failed', summary: outcome.error } };
        if (outcome.type === 'result') {
          const message = `${expectedTerminalToolMessage(reviewerContract)} Plain reviewer messages are not accepted as terminal results.`;
          if (repairAttempts >= MAX_TERMINAL_CONTRACT_REPAIRS) return this.plannerFailure(message);
          repairAttempts++;
          outcome = await llm.continueAfterPlainText(`${message} Use tools. Write record://review.md?v=next if needed, then call emit_result with valid JSON arguments.`);
          continue;
        }
        if (reviewerContract.isTerminalToolName(outcome.toolName)) {
          const invalidTerminal = this.validateReviewerTerminal(outcome, reviewerContract);
          if (invalidTerminal) {
            if (repairAttempts >= MAX_TERMINAL_CONTRACT_REPAIRS) return this.plannerFailure(invalidTerminal);
            repairAttempts++;
            outcome = await llm.appendToolResult(outcome.toolCallId, { success: false, error: invalidTerminal }, () => [{ role: 'user', content: `${invalidTerminal} Call emit_result again with valid JSON arguments.` }]);
            continue;
          }
          const missingRecord = this.validateRequiredOpenRecord(input.card.id, 'review.md');
          if (missingRecord) {
            if (repairAttempts >= MAX_TERMINAL_CONTRACT_REPAIRS) return this.plannerFailure(missingRecord);
            repairAttempts++;
            outcome = await llm.appendToolResult(outcome.toolCallId, { success: false, error: missingRecord }, () => [{ role: 'user', content: `${missingRecord} Create record://review.md?v=next, then call emit_result again.` }]);
            continue;
          }
          const staleReason = this.reviewerCurrentnessStaleReason(input, currentness);
          if (staleReason) {
            discardOpenRecordSlot(this.projectRoot, { cardId: input.card.id, filename: 'review.md', reason: 'stale_review' });
            llm.abandonParkedTurn();
            if (reviewerRelaunchAttempts >= 2) return this.plannerFailure(`Reviewer currentness relaunch budget exhausted: ${staleReason}`);
            reviewerRelaunchAttempts++;
            break;
          }
          const closeError = this.closeRequiredRecord(input.card.id, 'review.md', 'reviewer', input.card.version_seq);
          if (closeError) return this.plannerFailure(closeError);
          return evaluateReviewerTerminalOutcome({
            card: input.card,
            candidatePlanning: planning,
            assessmentId,
            sessionId,
            outcome,
            store: this.store,
          });
        }
        const toolResult = await this.handleReviewerToolCall(input.card, sessionId, outcome);
        outcome = await llm.appendToolResult(outcome.toolCallId, toolResult, (inputId) => this.notificationContextMessages(input, inputId));
      }
    }
  }

  private buildReviewerLlmInput(input: CardActivationInput, assessmentId: string, sessionId: string, currentness: ReviewerCurrentnessSnapshot): LlmInvocationInput {
    const contract = createReviewerContract();
    const inputId = this.nextInvocationInputId('reviewer');
    return {
      inputId,
      agentId: reviewerActorId(input.card.id),
      role: 'reviewer',
      sessionId,
      systemPrompt: this.reviewerPrompt(input.card, assessmentId),
      contextMessages: [this.reviewerDescendantContext(input.card.id, currentness)],
      tools: [...surfaceToolDefinitions(this.reviewerInvocationSurface(input.card.id, sessionId)), ...contract.terminals.map((terminal) => terminal.toolDefinition)],
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller, assessmentId },
    };
  }

  private plannerFailure(error: string): PlannerProcessorOutcome {
    return { status: 'failed', summary: error, result: { kind: 'failed', summary: error } };
  }

  private validatePlannerTerminal(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, contract = createPlannerContract()): string | null {
    try {
      verifyTerminalToolOutcome(contract, outcome);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private validateReviewerTerminal(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, contract = createReviewerContract()): string | null {
    try {
      verifyTerminalToolOutcome(contract, outcome);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private closeRequiredRecord(cardId: string, filename: 'status.md' | 'review.md', writer: 'planner' | 'reviewer', cardVersionSeq: number): string | null {
    try {
      closeOpenRecordSlot(this.projectRoot, { cardId, filename, writer, cardVersionSeq });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private validateRequiredOpenRecord(cardId: string, filename: 'status.md' | 'review.md'): string | null {
    try {
      const slot = filename.slice(0, -'.md'.length);
      const index = readRecordSlotIndex(this.projectRoot, cardId, slot);
      if (index.open === null) return `Required record 'record://${filename}?card=${cardId}&v=next' was not created.`;
      const open = concreteRecordSlot(this.projectRoot, { cardId, filename, version: index.open });
      if (!recordFileIsNonEmpty(open.absolutePath)) return `Required record '${open.recordUrl}' was not created or is empty.`;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private directChildren(cardId: string): CardRecord[] {
    return (this.store.listChildren?.(cardId) ?? []).map((id) => this.store.read(id)).filter((card): card is CardRecord => card !== null);
  }

  private descendants(cardId: string): CardRecord[] {
    const result: CardRecord[] = [];
    for (const child of this.directChildren(cardId)) {
      result.push(child, ...this.descendants(child.id));
    }
    return result;
  }

  private reviewerDescendantContext(cardId: string, currentness: ReviewerCurrentnessSnapshot): { role: 'user'; content: string } {
    const recordVersions = new Map(currentness.includedRecordVersions.map((entry) => [entry.cardId, entry.latest]));
    const lines = this.descendants(cardId).map((card) => {
      let recordUrl = 'no closed status record';
      const version = recordVersions.get(card.id) ?? null;
      if (version !== null) recordUrl = `record://status.md?card=${encodeURIComponent(card.id)}&v=${version}`;
      const result = card.lifecycle.result;
      const resultSummary = result && 'summary' in result && typeof result.summary === 'string' ? result.summary : result && 'error' in result && typeof result.error === 'string' ? result.error : '';
      return `- ${card.id} (${card.type}, ${card.status}): ${card.title}; result=${result?.kind ?? 'none'}${resultSummary ? `; summary=${resultSummary}` : ''}; record=${recordUrl}`;
    });
    return { role: 'user', content: `Descendant work:\n${lines.length > 0 ? lines.join('\n') : '(none)'}` };
  }

  private captureReviewerCurrentness(input: CardActivationInput): ReviewerCurrentnessSnapshot {
    const cards = this.reviewedSubtree(input.card.id).map((card) => ({ id: card.id, status: card.status, versionSeq: card.version_seq }));
    const includedRecordVersions = this.descendants(input.card.id).map((card) => ({ cardId: card.id, filename: 'status.md' as const, latest: latestClosedRecordVersion(this.projectRoot, card.id, 'status.md') }));
    return { cards, includedRecordVersions, hasPendingNotifications: input.notificationDelivery.hasPendingNotifications?.() ?? false };
  }

  private reviewerCurrentnessStaleReason(input: CardActivationInput, snapshot: ReviewerCurrentnessSnapshot): string | null {
    const current = this.captureReviewerCurrentness(input);
    if (current.hasPendingNotifications !== snapshot.hasPendingNotifications) return 'pending notification state changed during review';
    const snapshotCards = new Map(snapshot.cards.map((card) => [card.id, card]));
    const currentCards = new Map(current.cards.map((card) => [card.id, card]));
    if (snapshotCards.size !== currentCards.size) return 'reviewed subtree card set changed during review';
    for (const [id, before] of snapshotCards) {
      const after = currentCards.get(id);
      if (!after) return `reviewed subtree card '${id}' was removed during review`;
      if (after.status !== before.status || after.versionSeq !== before.versionSeq) return `reviewed subtree card '${id}' changed during review`;
    }
    const snapshotRecords = new Map(snapshot.includedRecordVersions.map((entry) => [`${entry.cardId}:${entry.filename}`, entry.latest]));
    const currentRecords = new Map(current.includedRecordVersions.map((entry) => [`${entry.cardId}:${entry.filename}`, entry.latest]));
    if (snapshotRecords.size !== currentRecords.size) return 'reviewer context record set changed during review';
    for (const [key, before] of snapshotRecords) {
      if (!currentRecords.has(key)) return `reviewer context record '${key}' disappeared during review`;
      if (currentRecords.get(key) !== before) return `reviewer context record '${key}' changed during review`;
    }
    return null;
  }

  private reviewedSubtree(cardId: string): CardRecord[] {
    const root = this.store.read(cardId);
    if (!root) throw new Error(`Reviewed card '${cardId}' not found.`);
    return [root, ...this.descendants(cardId)];
  }

  private plannerPrompt(card: CardRecord): string {
    return `Plan and coordinate card ${card.id}: ${card.title}\n\n${cardBriefForPrompt(this.projectRoot, card)}\n\nUse create_card for new immediate children of this card. create_card creates a backlog child but does not run it. Use edit_card to correct or refine non-running immediate children. Use reorder_child to reorder immediate children. Use queue_notification to leave targeted context for another agent session. Use cancel_card for obsolete immediate children. Use activate_card for immediate children only when work should execute. If this goal is incomplete and no existing child can make progress, create or edit the next useful immediate child card instead of reporting blocked.\n\nWrite your current invocation status to:\nrecord://status.md?v=next\n\nDo not call emit_result until the status file exists. End by calling emit_result with status done, blocked, or failed and a summary; plain text or JSON messages are not accepted as terminal reports.`;
  }

  private reviewerPrompt(card: CardRecord, assessmentId: string): string {
    return `Review card ${card.id}: ${card.title}\n\n${cardBriefForPrompt(this.projectRoot, card)}\n\nAssessment id: ${assessmentId}\n\nWrite your review to:\nrecord://review.md?v=next\n\nDo not call emit_result until the review file exists. End by calling emit_result with status done, rework, blocked, or failed and a summary; plain text or JSON messages are not accepted as terminal reports.`;
  }

  private async handleReviewerToolCall(card: CardRecord, sessionId: string, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): Promise<unknown> {
    const workspaceSurface = this.reviewerInvocationSurface(card.id, sessionId);
    if (workspaceSurface.tools.has(outcome.toolName)) return invokeTool(workspaceSurface, outcome.toolName, outcome.args);
    return { success: false, error: `Unsupported reviewer tool call '${outcome.toolName}' for session '${sessionId}'.` };
  }

  private reviewerInvocationSurface(cardId: string, sessionId: string) {
    return buildInvocationSurface('reviewer', [
      createWorkspaceProvider({ projectRoot: this.projectRoot, cardId, agentRole: 'reviewer' }),
      createCardHistoryProvider({ projectRoot: this.projectRoot, sessionId, agentRole: 'reviewer' }),
      createWebProvider({ projectRoot: this.projectRoot, cardId, agentRole: 'reviewer' }),
      createSkillProvider({ projectRoot: this.projectRoot, agentRole: 'reviewer' }),
      createMcpProvider({ mcpManagerProvider: this.mcpManagerProvider, agentRole: 'reviewer' }),
    ]);
  }

  protected get processorLabel(): string {
    return 'Planner processor';
  }

  protected get processorKind(): 'planning' {
    return 'planning';
  }

  protected activationFailureOutcome(error: string): PlannerProcessorOutcome {
    return { status: 'failed', summary: error, result: { kind: 'failed', summary: error } };
  }
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

function latestClosedRecordVersion(projectRoot: string, cardId: string, filename: 'status.md'): number | null {
  try {
    return latestClosedRecordSlot(projectRoot, { cardId, filename }).version;
  } catch {
    return null;
  }
}
