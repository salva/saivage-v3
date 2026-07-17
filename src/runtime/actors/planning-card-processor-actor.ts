import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardRecord, CardStatus, DoneResult } from '../../schemas/index.js';
import type { CompactorPort, LLMActorOutcome, LLMProviderPort } from './llm-actor.js';
import { plannerActorId, reviewerActorId } from './ids.js';
import { cardActivationOutcomePatch, type CardActivationInput, type CardActivationOutcome, type CardActor, type CardCancellationResult, type CardActorStorePort, type CardProcessorActor } from './card-actor.js';
import type { CardNotification } from '../../schemas/index.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { createPlannerContract, type PlannerTypedResult } from '../../contracts/planner-contract.js';
import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import { expectedTerminalToolMessage, verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import { reviewerSessionId } from '../reviewer-session.js';
import { evaluateReviewerTerminalOutcome } from './reviewer-terminal-evaluation.js';
import { invokeToolForLlm, surfaceToolDefinitions, type InvocationSurface, type ToolResult } from '../../tools/invocation.js';
import { buildRoleSurface } from '../../tools/role-invocation-surfaces.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { NotifyCardResult } from '../runtime-api.js';
import { cardBriefForPrompt } from '../records/card-brief.js';
import { runContractRepairLoop } from './contract-repair-loop.js';
import type { RuntimeGate } from '../runtime-gate.js';
import { appendActivationMarker, appendCanonicalUserText, appendRecoveryNotice, appendUserContextMessage, providerConversationProjection, readConversationMessages } from './conversation-session.js';
import { stabilizeRoleSession } from './conversation-recovery.js';
import { prepareCompaction, type CompactionConfig } from './compaction/compactor.js';
import { formatPromptToolList, type PromptTemplateRegistry } from '../../utils/prompt-api.js';
import type { ConversationChangePublisher } from './conversation-publisher.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';
import type { AppLogContext } from '../../persistence/app-log.js';
import type { CardService } from '../../cards/card-service.js';

type PlannerProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

type ReviewerCurrentnessSnapshot = {
  cards: Array<{ id: string; fingerprint: string }>;
  includedRecordVersions: Array<{ cardId: string; filename: 'status.md'; latest: number | null; contentHash: string | null }>;
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

  readonly store: CardService;
  readonly children: PlannerChildActorPort;
  readonly notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;
  readonly cancelCard: (cardId: string, reason: string) => Promise<CardCancellationResult>;

  private readonly mcpManagerProvider: () => McpToolInvocationPort | undefined;
  private readonly promptTemplates: PromptTemplateRegistry;
  private readonly appLogs: AppLogContext;

  constructor(args: { projectRoot: string; cardId: string; store: CardService; children: PlannerChildActorPort; cancelCard: (cardId: string, reason: string) => Promise<CardCancellationResult>; provider: LLMProviderPort; conversations: ConversationFileContext; appLogs: AppLogContext; promptTemplates: PromptTemplateRegistry; runtimeProjectionChanged: () => void; gate?: RuntimeGate; notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult; mcpManagerProvider?: () => McpToolInvocationPort | undefined; compactor?: CompactorPort; compactionConfig?: CompactionConfig; summarizerProvider?: LLMProviderPort; conversationPublisher?: ConversationChangePublisher }) {
    super(args);
    this.store = args.store;
    this.children = args.children;
    this.notifyCard = args.notifyCard;
    this.cancelCard = args.cancelCard;
    this.mcpManagerProvider = args.mcpManagerProvider ?? (() => undefined);
    this.promptTemplates = args.promptTemplates;
    this.appLogs = args.appLogs;
  }

  _on_enter__planning(): void {
    this.runPendingActivation('planning', (input, signal) => this.runActivation(input, signal));
  }

  private async runActivation(input: CardActivationInput, signal: AbortSignal): Promise<PlannerProcessorOutcome> {
    const contract = createPlannerContract();
    const llm = this.createMainLlm(plannerActorId(this.cardId));
    this.discardOpenRecord(input.card.id, 'status.md', 'new_activation');
    for (;;) {
      const surface = this.plannerInvocationSurface(input.card.id);
      const outcome = await this.resolveInitialOutcome(llm, () => this.buildLlmInput(input, surface, contract), surface, (name) => contract.isTerminalToolName(name), signal, (inputId) => this.notificationContext(input, inputId));
      const result = await runContractRepairLoop<PlannerProcessorOutcome>({
      initialOutcome: outcome,
      isTerminalToolName: (name) => contract.isTerminalToolName(name),
      fail: (message) => this.plannerFailure(message),
      onPlainText: async (_outcome, control) => {
        const message = `${expectedTerminalToolMessage(contract)} Plain planner messages are not accepted as terminal results.`;
        return control.repair(() => llm.continueAfterPlainText(`${message} Use tools. Write record:///status.md?v=next if needed, then call emit_result with valid JSON arguments.`, signal, (inputId) => this.notificationContext(input, inputId)));
      },
      onTerminalTool: async (terminalOutcome, control) => {
        const invalidTerminal = this.validatePlannerTerminal(terminalOutcome, contract);
        if (invalidTerminal) {
          return control.repair(() => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: `${invalidTerminal} Call emit_result again with valid JSON arguments.` }, signal, (inputId) => this.notificationContext(input, inputId)));
        }
        const missingRecord = this.validateRequiredOpenRecord(input.card.id, 'status.md');
        if (missingRecord) {
          return control.repair(() => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: `${missingRecord} Create record:///status.md?v=next, then call emit_result again.` }, signal, (inputId) => this.notificationContext(input, inputId)));
        }
        const completionGateFailure = this.validatePlannerCompletionGate(terminalOutcome, contract);
        if (completionGateFailure) {
          return control.repair(() => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: completionGateFailure }, signal, (inputId) => this.notificationContext(input, inputId)));
        }
        const currentCard = this.store.read(input.card.id);
        if (!currentCard) throw new Error(`Planner card '${input.card.id}' disappeared before terminal acceptance.`);
        const pending = [...currentCard.pending_notifications];
        if (pending.length > 0) {
          return control.continue(await llm.appendToolResult(terminalOutcome.toolCallId, {
            success: false,
            error: 'emit_result was not accepted because new operator context is pending. Consider the appended notifications, update the required record, and call emit_result again.',
            data: { reason: 'pending_notifications' },
          }, signal, (inputId) => this.notificationContext(input, inputId)));
        }
        const direct = projectPlannerTerminalOutcome(terminalOutcome);
        const hasReviewableChildren = direct === null && this.directChildren(input.card.id).length > 0;
        if (direct || !hasReviewableChildren) input.claimResult();
        const closeError = this.closeRequiredRecord(input.card.id, 'status.md', 'planner', currentCard.version_seq);
        if (closeError) return control.done(this.plannerFailure(closeError));
        llm.settleToolResultWithoutContinuation(terminalOutcome.toolCallId, { success: true, data: { accepted: true } });
        if (direct) {
          this.store.commitTerminalLifecyclePatch(this.cardId, cardActivationOutcomePatch(direct, new Date().toISOString()));
          return control.done(direct);
        }
        if (!hasReviewableChildren) {
          const accepted = { status: 'done' as const, summary: verifyTerminalToolOutcome(contract, terminalOutcome).result.result.summary, result: { kind: 'done' as const, summary: verifyTerminalToolOutcome(contract, terminalOutcome).result.result.summary } };
          this.store.commitTerminalLifecyclePatch(this.cardId, cardActivationOutcomePatch(accepted, new Date().toISOString()));
          return control.done(accepted);
        }
        const projected = await this.reviewPlannerDone(input, { kind: 'done', summary: verifyTerminalToolOutcome(contract, terminalOutcome).result.result.summary }, signal);
        signal.throwIfAborted();
        return control.done(projected);
      },
      onNonTerminalTool: async (toolOutcome) => {
        const toolResult = await this.handleToolCall(surface, toolOutcome, signal);
        signal.throwIfAborted();
        return llm.appendToolResult(toolOutcome.toolCallId, toolResult, signal, (inputId) => this.notificationContext(input, inputId));
      },
      });
      if (result.kind === 'restart') continue;
      if (result.value.result.kind === 'rework') continue;
      return result.value;
    }
  }

  private buildLlmInput(input: CardActivationInput, surface: InvocationSurface, contract = createPlannerContract()): LlmInvocationInput {
    const inputId = this.freshSourceInputId();
    const sessionId = plannerActorId(this.cardId);
    const systemPrompt = this.plannerPrompt(input.card, surface, contract);
    const tools = [...surfaceToolDefinitions(surface), ...contract.terminals.map((terminal) => terminal.toolDefinition)];
    const preparedCompaction = this.compactionConfig?.enabled ? prepareCompaction(this.compactionConfig, systemPrompt, tools) : null;
    const stabilized = stabilizeRoleSession({ projectRoot: this.projectRoot, sessionId, conversations: this.conversations, terminalToolNames: new Set(contract.terminals.map((terminal) => terminal.name)) });
    const activationMarker = appendActivationMarker(this.conversations, sessionId, { event: 'activation_open', role: 'planner', card_id: this.cardId, input_id: inputId });
    this.conversationPublisher?.entryAppended(activationMarker);
    const recovery = stabilized.interrupted ? appendRecoveryNotice(this.conversations, sessionId, inputId) : null;
    if (recovery) this.conversationPublisher?.entryAppended(recovery);
    const selected = input.notificationDelivery.selectNotifications();
    const notifications = selected.map((notification, index) => {
      const message = { role: 'user' as const, content: notification.content };
      const result = appendUserContextMessage(this.conversations, sessionId, inputId, 'notification', index, message);
      this.conversationPublisher?.entryAppended(result);
      return result;
    });
    if (selected.length > 0) input.notificationDelivery.removeNotifications(selected.map((notification) => notification.id));
    return {
      inputId,
      agentId: sessionId,
      role: 'planner',
      sessionId,
      systemPrompt,
      providerConversation: providerConversationProjection(readConversationMessages(this.projectRoot, sessionId)),
      tools,
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      ...(preparedCompaction ? { preparedCompaction } : {}),
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller, children: this.directChildren(input.card.id).map((card) => ({ id: card.id, status: card.status, type: card.type, title: card.title })) },
    };
  }

  private async handleToolCall(surface: InvocationSurface, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, signal: AbortSignal): Promise<ToolResult> {
    if (!surface.tools.has(outcome.toolName)) return { success: false, error: `Unsupported planner tool call '${outcome.toolName}'.` };
    return invokeToolForLlm(surface, outcome.toolName, outcome.args, signal);
  }

  private plannerInvocationSurface(parentCardId: string) {
    return buildRoleSurface('planner', { projectRoot: this.projectRoot, cardId: parentCardId, sessionId: plannerActorId(parentCardId), store: this.store, children: this.children, cancelCard: this.cancelCard, notifyCard: this.notifyCard, appLogs: this.appLogs });
  }

  private async projectPlannerTerminal(input: CardActivationInput, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, signal: AbortSignal, contract = createPlannerContract()): Promise<PlannerProcessorOutcome> {
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
      if (blocker) return this.plannerFailure(this.completionGateFailureMessage(blocker));
      const summary = parsed.summary;
      return this.reviewPlannerDone(input, { kind: 'done', summary }, signal);
    }
    if (parsed.status === 'blocked') {
      const summary = parsed.summary;
      return { status: 'blocked', summary, result: { kind: 'blocked', summary, resume_reason: summary } };
    }
    return { status: 'failed', summary: parsed.summary, result: { kind: 'failed', summary: parsed.summary } };
  }

  private reviewerReworkPlannerMessage(cardId: string, summary: string): string {
    const reviewUrl = this.store.readRecord(cardId, 'review.md', 'latest').recordUrl;
    return `Reviewer requested rework at ${reviewUrl}. Read it for required changes, update or create the necessary child cards, activate the rework, write record:///status.md?v=next, then call emit_result again when ready for review. Reviewer summary: ${summary}`;
  }

  private async reviewPlannerDone(input: CardActivationInput, planning: DoneResult, signal: AbortSignal): Promise<PlannerProcessorOutcome> {
    if (this.directChildren(input.card.id).length === 0) return { status: 'done', summary: planning.summary, result: planning };
    const sessionId = reviewerSessionId(input.card.id);
    const llm = this.createMainLlm(reviewerActorId(input.card.id));
    const reviewerContract = createReviewerContract();
    for (;;) {
      this.discardOpenRecord(input.card.id, 'review.md', 'new_reviewer_activation');
      const currentness = this.captureReviewerCurrentness(input);
      const surface = this.reviewerInvocationSurface(input.card.id, sessionId);
      const outcome = await this.resolveInitialOutcome(llm, () => this.buildReviewerLlmInput(input, sessionId, currentness, surface, reviewerContract), surface, (name) => reviewerContract.isTerminalToolName(name), signal);
      const review = await runContractRepairLoop<PlannerProcessorOutcome>({
        initialOutcome: outcome,
        isTerminalToolName: (name) => reviewerContract.isTerminalToolName(name),
        fail: (message) => this.plannerFailure(message),
        onPlainText: async (_outcome, control) => {
          const message = `${expectedTerminalToolMessage(reviewerContract)} Plain reviewer messages are not accepted as terminal results.`;
          return control.repair(() => llm.continueAfterPlainText(`${message} Use tools. Write record:///review.md?v=next if needed, then call emit_result with valid JSON arguments.`, signal));
        },
        onTerminalTool: async (terminalOutcome, control) => {
          const invalidTerminal = this.validateReviewerTerminal(terminalOutcome, reviewerContract);
          if (invalidTerminal) {
            return control.repair(() => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: `${invalidTerminal} Call emit_result again with valid JSON arguments.` }, signal));
          }
          const missingRecord = this.validateRequiredOpenRecord(input.card.id, 'review.md');
          if (missingRecord) {
            return control.repair(() => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: `${missingRecord} Create record:///review.md?v=next, then call emit_result again.` }, signal));
          }
          const staleReason = this.reviewerCurrentnessStaleReason(input, currentness);
          const currentCard = this.store.read(input.card.id);
          if (!currentCard) throw new Error(`Reviewed card '${input.card.id}' disappeared before terminal acceptance.`);
          const pending = [...currentCard.pending_notifications];
          if (pending.length > 0) {
            this.discardOpenRecord(input.card.id, 'review.md', 'notification_deferred');
            llm.settleToolResultWithoutContinuation(terminalOutcome.toolCallId, { success: false, error: 'Review was not accepted because operator context is pending. Review is deferred until the planner consumes that context.', data: { reason: 'pending_notifications' } });
            return control.done({ status: 'blocked', summary: 'Review deferred for pending operator context.', result: { kind: 'rework', summary: 'Review deferred for pending operator context.' } });
          }
          if (staleReason) {
            this.discardOpenRecord(input.card.id, 'review.md', 'stale_review');
            return control.continue(await llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: `Review context is stale: ${staleReason}. Re-read the refreshed context, recreate review.md, and call emit_result again.` }, signal));
          }
          const accepted = evaluateReviewerTerminalOutcome({ outcome: terminalOutcome });
          if (accepted.result.kind !== 'rework') input.claimResult();
          const closeError = this.closeRequiredRecord(input.card.id, 'review.md', 'reviewer', currentCard.version_seq);
          if (closeError) return control.done(this.plannerFailure(closeError));
          llm.settleToolResultWithoutContinuation(terminalOutcome.toolCallId, { success: true, data: { accepted: true } });
          if (accepted.result.kind === 'rework') {
            const message = this.reviewerReworkPlannerMessage(input.card.id, accepted.summary);
            const appended = appendCanonicalUserText(this.conversations, plannerActorId(this.cardId), message);
            this.conversationPublisher?.entryAppended(appended);
          }
          if (accepted.result.kind !== 'rework') this.store.commitTerminalLifecyclePatch(this.cardId, cardActivationOutcomePatch(accepted, new Date().toISOString()));
          return control.done(accepted);
        },
        onNonTerminalTool: async (toolOutcome) => {
          const toolResult = await this.handleReviewerToolCall(surface, sessionId, toolOutcome, signal);
          signal.throwIfAborted();
          return llm.appendToolResult(toolOutcome.toolCallId, toolResult, signal);
        },
      });
      if (review.kind === 'restart') continue;
      return review.value;
    }
  }

  private buildReviewerLlmInput(input: CardActivationInput, sessionId: string, currentness: ReviewerCurrentnessSnapshot, surface: InvocationSurface, contract = createReviewerContract()): LlmInvocationInput {
    const inputId = this.freshSourceInputId();
    const systemPrompt = this.reviewerPrompt(input.card, surface, contract);
    const tools = [...surfaceToolDefinitions(surface), ...contract.terminals.map((terminal) => terminal.toolDefinition)];
    const preparedCompaction = this.compactionConfig?.enabled ? prepareCompaction(this.compactionConfig, systemPrompt, tools) : null;
    const stabilized = stabilizeRoleSession({ projectRoot: this.projectRoot, sessionId, conversations: this.conversations, terminalToolNames: new Set(contract.terminals.map((terminal) => terminal.name)) });
    const activationMarker = appendActivationMarker(this.conversations, sessionId, { event: 'activation_open', role: 'reviewer', card_id: input.card.id, input_id: inputId });
    this.conversationPublisher?.entryAppended(activationMarker);
    const recovery = stabilized.interrupted ? appendRecoveryNotice(this.conversations, sessionId, inputId) : null;
    if (recovery) this.conversationPublisher?.entryAppended(recovery);
    const descendantContext = appendUserContextMessage(this.conversations, sessionId, inputId, 'reviewer_descendant', 0, this.reviewerDescendantContext(input.card.id, currentness));
    this.conversationPublisher?.entryAppended(descendantContext);
    return {
      inputId,
      agentId: reviewerActorId(input.card.id),
      role: 'reviewer',
      sessionId,
      systemPrompt,
      providerConversation: providerConversationProjection(readConversationMessages(this.projectRoot, sessionId)),
      tools,
      terminalToolNames: contract.terminals.map((terminal) => terminal.name),
      modelParams: {},
      ...(preparedCompaction ? { preparedCompaction } : {}),
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: input.card.id, caller: input.caller },
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

  private validatePlannerCompletionGate(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, contract = createPlannerContract()): string | null {
    let typed: PlannerTypedResult;
    try {
      typed = verifyTerminalToolOutcome(contract, outcome).result;
    } catch {
      return null;
    }
    if (typed.result.status !== 'done') return null;
    const blocker = firstIncompleteDescendant(this.cardId, this.store);
    return blocker ? this.completionGateFailureMessage(blocker) : null;
  }

  private completionGateFailureMessage(blocker: { id: string; status: CardStatus }): string {
    return `Completion gate failed: cannot complete this goal while descendant '${blocker.id}' is '${blocker.status}'. Inspect the subtree, then activate and complete executable descendants, edit or create needed work, or cancel obsolete descendants before calling emit_result with status done again.`;
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
      const open = this.store.readRecord(cardId, filename, 'open');
      this.store.closeRecord(cardId, filename, open.version, writer, cardVersionSeq);
      return null;
    } catch (error) {
      if (error instanceof Error && error.message.includes(`'${cardId}/${filename.slice(0, -3)}/open'`)) return this.missingRequiredRecordMessage(cardId, filename);
      return error instanceof Error ? error.message : String(error);
    }
  }

  private validateRequiredOpenRecord(cardId: string, filename: 'status.md' | 'review.md'): string | null {
    try {
      const open = this.store.readRecord(cardId, filename, 'open');
      if (open.artifact.content.trim().length === 0) return `Required record '${open.recordUrl}' was not created or is empty.`;
      return null;
    } catch (error) {
      if (error instanceof Error && error.message.includes(`'${cardId}/${filename.slice(0, -3)}/open'`)) return this.missingRequiredRecordMessage(cardId, filename);
      return error instanceof Error ? error.message : String(error);
    }
  }

  private missingRequiredRecordMessage(cardId: string, filename: 'status.md' | 'review.md'): string {
    return `Required record 'record:///${filename}?card=${encodeURIComponent(cardId)}&v=next' was not created.`;
  }

  private discardOpenRecord(cardId: string, filename: string, reason: string): void {
    try {
      const open = this.store.readRecord(cardId, filename, 'open');
      this.store.discardRecord(cardId, filename, open.version, reason);
    } catch (error) {
      if (error instanceof Error && error.message.includes(`'${cardId}/${filename.slice(0, -3)}/open'`)) return;
      throw error;
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
      if (version !== null) recordUrl = `record:///status.md?card=${encodeURIComponent(card.id)}&v=${version}`;
      const result = card.lifecycle.result;
      const resultSummary = result && 'summary' in result && typeof result.summary === 'string' ? result.summary : result && 'error' in result && typeof result.error === 'string' ? result.error : '';
      return `- ${card.id} (${card.type}, ${card.status}): ${card.title}; result=${result?.kind ?? 'none'}${resultSummary ? `; summary=${resultSummary}` : ''}; record=${recordUrl}`;
    });
    return { role: 'user', content: `Descendant work:\n${lines.length > 0 ? lines.join('\n') : '(none)'}` };
  }

  private captureReviewerCurrentness(input: CardActivationInput): ReviewerCurrentnessSnapshot {
    const cards = this.reviewedSubtree(input.card.id).map((card) => ({ id: card.id, fingerprint: semanticCardFingerprint(card) }));
    const includedRecordVersions = this.descendants(input.card.id).map((card) => closedRecordFingerprint(this.store, card.id, 'status.md'));
    return { cards, includedRecordVersions };
  }

  private reviewerCurrentnessStaleReason(input: CardActivationInput, snapshot: ReviewerCurrentnessSnapshot): string | null {
    const current = this.captureReviewerCurrentness(input);
    const snapshotCards = new Map(snapshot.cards.map((card) => [card.id, card]));
    const currentCards = new Map(current.cards.map((card) => [card.id, card]));
    if (snapshotCards.size !== currentCards.size) return 'reviewed subtree card set changed during review';
    for (const [id, before] of snapshotCards) {
      const after = currentCards.get(id);
      if (!after) return `reviewed subtree card '${id}' was removed during review`;
      if (after.fingerprint !== before.fingerprint) return `reviewed subtree card '${id}' changed during review`;
    }
    const snapshotRecords = new Map(snapshot.includedRecordVersions.map((entry) => [`${entry.cardId}:${entry.filename}`, `${entry.latest}:${entry.contentHash}`]));
    const currentRecords = new Map(current.includedRecordVersions.map((entry) => [`${entry.cardId}:${entry.filename}`, `${entry.latest}:${entry.contentHash}`]));
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

  private plannerPrompt(card: CardRecord, surface: InvocationSurface, contract = createPlannerContract()): string {
    return this.promptTemplates.render(card.type, 'planner', {
      cardId: card.id,
      cardTitle: card.title,
      cardBrief: cardBriefForPrompt(this.store, card),
      contractDescription: contract.describe(),
      toolList: formatPromptToolList(surfaceToolDefinitions(surface)),
    });
  }

  private reviewerPrompt(card: CardRecord, surface: InvocationSurface, contract = createReviewerContract()): string {
    return this.promptTemplates.render(card.type, 'reviewer', {
      cardId: card.id,
      cardTitle: card.title,
      cardBrief: cardBriefForPrompt(this.store, card),
      contractDescription: contract.describe(),
      toolList: formatPromptToolList(surfaceToolDefinitions(surface)),
    });
  }

  private async handleReviewerToolCall(workspaceSurface: InvocationSurface, sessionId: string, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, signal: AbortSignal): Promise<ToolResult> {
    if (workspaceSurface.tools.has(outcome.toolName)) return invokeToolForLlm(workspaceSurface, outcome.toolName, outcome.args, signal);
    return { success: false, error: `Unsupported reviewer tool call '${outcome.toolName}' for session '${sessionId}'.` };
  }

  private reviewerInvocationSurface(cardId: string, sessionId: string) {
    return buildRoleSurface('reviewer', { projectRoot: this.projectRoot, cardId, sessionId, store: this.store.records(), mcpManagerProvider: this.mcpManagerProvider });
  }

  protected get processorLabel(): string {
    return 'Planner processor';
  }

  protected activationFailureOutcome(error: string): PlannerProcessorOutcome {
    return { status: 'failed', summary: error, result: { kind: 'failed', summary: error } };
  }
}

export function projectPlannerTerminalOutcome(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): PlannerProcessorOutcome | null {
  let typed: PlannerTypedResult;
  try {
    typed = verifyTerminalToolOutcome(createPlannerContract(), outcome).result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', summary: message, result: { kind: 'failed', summary: message } };
  }
  const parsed = typed.result;
  if (parsed.status === 'done') return null;
  if (parsed.status === 'blocked') {
    const summary = parsed.summary;
    return { status: 'blocked', summary, result: { kind: 'blocked', summary, resume_reason: summary } };
  }
  return { status: 'failed', summary: parsed.summary, result: { kind: 'failed', summary: parsed.summary } };
}

export function firstIncompleteDescendant(cardId: string, store: Pick<CardActorStorePort, 'read' | 'listChildren'>): { id: string; status: CardStatus } | null {
  if (!store.listChildren) throw new Error(`Cannot evaluate completion gate for card '${cardId}': store must provide listChildren for descendant traversal.`);
  for (const childId of store.listChildren(cardId)) {
    const child = store.read(childId);
    if (!child) throw new Error(`Cannot evaluate completion gate for card '${cardId}': child '${childId}' was listed but not found.`);
    if (child.status !== 'done' && child.status !== 'cancelled') return { id: child.id, status: child.status };
    const descendant = firstIncompleteDescendant(childId, store);
    if (descendant) return descendant;
  }
  return null;
}

function closedRecordFingerprint(store: Pick<CardActorStorePort, 'readRecord'>, cardId: string, filename: 'status.md'): ReviewerCurrentnessSnapshot['includedRecordVersions'][number] {
  try {
    const record = store.readRecord(cardId, filename, 'latest');
    return { cardId, filename, latest: record.version, contentHash: createHash('sha256').update(record.artifact.content).digest('hex') };
  } catch {
    return { cardId, filename, latest: null, contentHash: null };
  }
}

function semanticCardFingerprint(card: CardRecord): string {
  const semantic = {
    id: card.id,
    type: card.type,
    parent: card.parent,
    depth: card.depth,
    position: card.position,
    title: card.title,
    status: card.status,
    lifecycle: card.lifecycle,
    depends_on: card.depends_on,
    related: card.related,
    tags: card.tags,
    priority: card.priority,
    urgency: card.urgency,
    metadata: card.metadata,
    metrics: card.metrics,
    status_text: card.status_text,
  };
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}
import { createHash } from 'node:crypto';
