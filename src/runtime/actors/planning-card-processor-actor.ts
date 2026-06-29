import type { ActorDefinition } from '../micro-actor/index.js';
import { cardTypeValues, urgencyValues, type CardRecord, type CardStatus, type CardType, type PlannerDoneResult, type Urgency } from '../../schemas/index.js';
import type { LLMActorOutcome, LLMAdmissionPort, LLMProviderPort } from './llm-actor.js';
import { plannerActorId, reviewerActorId } from './ids.js';
import { PLANNER_ACTOR_SURFACE_TOOL_DEFINITIONS, PLANNER_CARD_PROCESSOR_TOOL_DEFINITIONS, REVIEWER_CARD_PROCESSOR_TOOL_DEFINITIONS } from './actor-tool-definitions.js';
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
import { processWorkspaceToolCall } from '../../agents/workspace-tools.js';
import { WORKSPACE_TOOL_NAMES } from '../../tools/definitions/index.js';
import { closeOpenRecordSlot, concreteRecordSlot, discardOpenRecordSlot, latestClosedRecordSlot, readRecordSlotIndex, recordFileIsNonEmpty } from '../records/record-slots.js';
import { cardBriefForPrompt } from '../records/card-brief.js';

type PlannerProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

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
    discardOpenRecordSlot(this.projectRoot, { cardId: input.card.id, filename: 'status.md', reason: 'new_activation' });
    let outcome = await llm.turn(this.buildLlmInput(input, contract));
    let recordRepairAttempts = 0;
    while (true) {
      if (outcome.type === 'result') return this.plannerFailure(`${expectedTerminalToolMessage(contract)} Plain planner messages are not accepted as terminal results.`);
      if (outcome.type === 'error') return this.plannerFailure(outcome.error);
      if (contract.isTerminalToolName(outcome.toolName)) {
        const missingRecord = this.closeRequiredRecord(input.card.id, 'status.md', 'planner', input.card.version_seq);
        if (missingRecord) {
          recordRepairAttempts++;
          if (recordRepairAttempts > 2) return this.plannerFailure(missingRecord);
          outcome = await llm.appendToolResult(outcome.toolCallId, { success: false, error: missingRecord }, () => [{ role: 'user', content: `${missingRecord} Create record://status.md?v=next, then call emit_planner_result again.` }]);
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
    if (WORKSPACE_TOOL_NAMES.has(outcome.toolName)) {
      try {
        return await processWorkspaceToolCall(outcome.toolName, JSON.stringify(outcome.args), { projectRoot: this.projectRoot, cardId: parent.id, sessionId: plannerActorId(parent.id), agentRole: 'planner' });
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
      let recordRepairAttempts = 0;
      while (true) {
        if (outcome.type === 'error') return { status: 'failed', summary: outcome.error, result: { kind: 'planner_failure', error: outcome.error } };
        if (outcome.type === 'result') return this.plannerFailure(`${expectedTerminalToolMessage(reviewerContract)} Plain reviewer messages are not accepted as terminal results.`);
        if (reviewerContract.isTerminalToolName(outcome.toolName)) {
          const missingRecord = this.validateRequiredOpenRecord(input.card.id, 'review.md');
          if (missingRecord) {
            recordRepairAttempts++;
            if (recordRepairAttempts > 2) return this.plannerFailure(missingRecord);
            outcome = await llm.appendToolResult(outcome.toolCallId, { success: false, error: missingRecord }, () => [{ role: 'user', content: `${missingRecord} Create record://review.md?v=next, then call emit_reviewer_result again.` }]);
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
      tools: [...REVIEWER_CARD_PROCESSOR_TOOL_DEFINITIONS, ...contract.terminals.map((terminal) => terminal.toolDefinition)],
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller, assessmentId },
    };
  }

  private plannerFailure(error: string): PlannerProcessorOutcome {
    return { status: 'failed', summary: error, result: { kind: 'planner_failure', error } };
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
    return `Plan and coordinate card ${card.id}: ${card.title}\n\n${cardBriefForPrompt(this.projectRoot, card)}\n\nUse create_card for new immediate children of this card. create_card creates a backlog child but does not run it. Use edit_card to correct or refine non-running immediate children. Use cancel_card for obsolete immediate children. Use activate_card for immediate children only when work should execute. If this goal is incomplete and no existing child can make progress, create or edit the next useful immediate child card instead of reporting blocked.\n\nWrite your current invocation status to:\nrecord://status.md?v=next\n\nDo not call emit_planner_result until the status file exists. End by calling emit_planner_result with status done, blocked, or continue; plain text or JSON messages are not accepted as terminal reports.`;
  }

  private reviewerPrompt(card: CardRecord, assessmentId: string): string {
    return `Review card ${card.id}: ${card.title}\n\n${cardBriefForPrompt(this.projectRoot, card)}\n\nAssessment id: ${assessmentId}\n\nWrite your review to:\nrecord://review.md?v=next\n\nDo not call emit_reviewer_result until the review file exists. End by calling emit_reviewer_result with the assessment envelope; plain text or JSON messages are not accepted as terminal reports.`;
  }

  private async handleReviewerToolCall(card: CardRecord, sessionId: string, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): Promise<unknown> {
    try {
      return await processWorkspaceToolCall(outcome.toolName, JSON.stringify(outcome.args), { projectRoot: this.projectRoot, cardId: card.id, sessionId, agentRole: 'reviewer' });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private createPlannerToolSurface(): ActorToolSurface {
    const definitions = new Map(PLANNER_ACTOR_SURFACE_TOOL_DEFINITIONS.map((definition) => [definition.function.name, definition]));
    return new ActorToolSurface([
      {
        name: 'create_card',
        definition: requiredDefinition(definitions, 'create_card'),
        execute: (args) => this.handleCreateCard(args),
      },
      {
        name: 'edit_card',
        definition: requiredDefinition(definitions, 'edit_card'),
        execute: (args) => this.handleEditCard(args),
      },
      {
        name: 'cancel_card',
        definition: requiredDefinition(definitions, 'cancel_card'),
        execute: (args) => this.handleCancelCard(args),
      },
    ]);
  }

  private handleCreateCard(args: unknown): unknown {
    const record = requireRecordArgs(args, 'create_card');
    assertAllowedFields(record, 'create_card', ['type', 'title', 'brief', 'status', 'tags', 'priority', 'urgency', 'depends_on', 'related']);
    const type = requirePlannerCreatedType(record.type);
    const status = optionalString(record.status, 'status');
    if (status !== undefined && status !== 'backlog') throw new Error('create_card.status may only be backlog for planner-created child cards.');
    const dependsOn = optionalStringArray(record.depends_on, 'depends_on');
    this.assertImmediateChildDependencies(dependsOn);
    const parent = this.store.read(this.cardId);
    if (!parent) throw new Error(`Planner parent card '${this.cardId}' not found.`);
    const input: NewCardInput = {
      type,
      parent: this.cardId,
      depth: parent.depth + 1,
      title: requireNonEmptyString(record.title, 'title'),
      brief: requireNonEmptyString(record.brief, 'brief'),
      status: 'backlog',
      tags: optionalStringArray(record.tags, 'tags'),
      priority: optionalInteger(record.priority, 'priority') ?? 0,
      urgency: optionalUrgency(record.urgency),
      created_by: 'planner',
      depends_on: dependsOn,
      related: optionalStringArray(record.related, 'related'),
      retries: 0,
    };
    if (!this.store.create) throw new Error('Planner create_card requires a mutable card store.');
    const card = this.store.create(input);
    return { success: true, card: compactPlannerToolCard(card) };
  }

  private handleEditCard(args: unknown): unknown {
    const record = requireRecordArgs(args, 'edit_card');
    assertAllowedFields(record, 'edit_card', ['card_id', 'title', 'tags', 'priority', 'urgency', 'related']);
    const cardId = requireToolCardId(record, 'edit_card');
    const child = this.requireImmediateChild(cardId, 'edit_card');
    if (child.status === 'running') throw new Error(`edit_card cannot edit running child '${cardId}'.`);
    if (child.status === 'done') throw new Error(`edit_card cannot edit done child '${cardId}'.`);
    if (child.status === 'cancelled') throw new Error(`edit_card cannot edit cancelled child '${cardId}'.`);
    if (child.status === 'needs_verification') throw new Error(`edit_card cannot edit needs_verification child '${cardId}'.`);
    const patch = plannerEditablePatch(record);
    if (Object.keys(patch).length === 0) throw new Error('edit_card requires at least one editable field.');
    if (!this.store.mutateCard) throw new Error('Planner edit_card requires a mutable card store.');
    if (child.status === 'failed' || child.status === 'blocked') this.store.setStatus(cardId, 'changed');
    const updated = this.store.mutateCard(cardId, patch, { actor: 'planner', surface: 'runtime', reason: 'planner edit_card' });
    return { success: true, card: compactPlannerToolCard(updated) };
  }

  private handleCancelCard(args: unknown): unknown {
    const record = requireRecordArgs(args, 'cancel_card');
    assertAllowedFields(record, 'cancel_card', ['card_id', 'reason']);
    const cardId = requireToolCardId(record, 'cancel_card');
    const child = this.requireImmediateChild(cardId, 'cancel_card');
    if (child.status === 'done') throw new Error(`cancel_card cannot cancel done child '${cardId}'.`);
    if (child.status === 'cancelled') throw new Error(`cancel_card cannot cancel already-cancelled child '${cardId}'.`);
    if (child.status === 'needs_verification') throw new Error(`cancel_card cannot cancel needs_verification child '${cardId}'.`);
    const actor = this.children.get(cardId);
    if (!actor) throw new Error(`No CardActor is registered for child '${cardId}'.`);
    const reason = optionalString(record.reason, 'reason') ?? 'planner_cancel_card';
    actor.cancel({ reason, cancelled_at: new Date().toISOString() });
    const updated = this.store.read(cardId);
    if (!updated) throw new Error(`Child card '${cardId}' not found after cancellation.`);
    return { success: true, card_id: cardId, status: updated.status, summary: updated.status === 'running' ? 'Cancellation requested.' : 'Cancelled.' };
  }

  private requireImmediateChild(cardId: string, toolName: string): CardRecord {
    const child = this.store.read(cardId);
    if (!child) throw new Error(`${toolName} target child '${cardId}' not found.`);
    if (child.parent !== this.cardId) throw new Error(`${toolName} can target only immediate children of '${this.cardId}'.`);
    if (child.type === 'project') throw new Error(`${toolName} cannot target project cards.`);
    return child;
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

function assertAllowedFields(record: Record<string, unknown>, toolName: string, allowed: string[]): void {
  const invalid = Object.keys(record).filter((key) => !allowed.includes(key));
  if (invalid.length > 0) throw new Error(`${toolName} does not accept fields: ${invalid.join(', ')}.`);
}

function requireToolCardId(record: Record<string, unknown>, toolName: string): string {
  const cardId = record.card_id;
  if (typeof cardId !== 'string' || cardId.length === 0) throw new Error(`${toolName} requires card_id.`);
  return cardId;
}

function plannerEditablePatch(record: Record<string, unknown>): Partial<CardRecord> {
  const patch: Partial<CardRecord> = {};
  if (record.title !== undefined) patch.title = requireNonEmptyString(record.title, 'title');
  if (record.tags !== undefined) patch.tags = optionalStringArray(record.tags, 'tags');
  if (record.priority !== undefined) patch.priority = optionalInteger(record.priority, 'priority') ?? 0;
  if (record.urgency !== undefined) patch.urgency = requireUrgency(record.urgency);
  if (record.related !== undefined) patch.related = optionalStringArray(record.related, 'related');
  return patch;
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

function compactPlannerToolCard(card: CardRecord): Pick<CardRecord, 'id' | 'type' | 'parent' | 'status' | 'title' | 'depends_on' | 'related' | 'tags' | 'priority' | 'urgency'> {
  return {
    id: card.id,
    type: card.type,
    parent: card.parent,
    status: card.status,
    title: card.title,
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

function latestClosedRecordVersion(projectRoot: string, cardId: string, filename: 'status.md'): number | null {
  try {
    return latestClosedRecordSlot(projectRoot, { cardId, filename }).version;
  } catch {
    return null;
  }
}
