import { randomUUID } from 'node:crypto';
import { ProviderTurnFailure, type LlmCompleteResult, type ProviderTurnCompletion } from '../../agents/llm-contracts.js';
import { LlmRequestError, type LlmTransportFailure } from '../../contracts/llm-failure.js';
import { CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY, conversationSessionIdentity, parseConversationSessionId, type ContentPolicyRefusalBlockedResult, type ConversationSessionId } from '../../schemas/index.js';
import { buildContentPolicyRefusalMessage, buildContentPolicyRetryMessage } from './content-policy-messages.js';
import type { CardId } from '../../schemas/card-id.js';
import type { CanonicalLlmInvocationInput, LlmInvocationInput, PreparedLlmInvocationInput } from './llm-invocation.js';
import { appendLlmTurnError, appendLlmTurnMessageBatch, appendLlmTurnStarted, appendLlmTurnToolCallBatch, appendModelRepairMessage, appendToolResult, readLoggedToolCall } from './llm-delivery-log.js';
import { buildUserContextMessage, providerConversationProjection, type ProviderVisibleUserContextMessage } from './conversation-session.js';
import { appendConversationBatch, readConversation, type ConversationFileContext } from '../../persistence/conversation-file.js';
import type { ToolResult } from '../../tools/invocation.js';
import { RuntimeGate } from '../runtime-gate.js';
import { deferred, type Deferred } from './deferred.js';
import { InvocationLifecycle, type InvocationJoinOutcome, type InvocationLease } from './invocation-lifecycle.js';
import type { ProviderExchangeAttempt, ProviderExchangePublicationContext } from '../../contracts/provider-exchange.js';
import { CompactionAppendError, CompactionSummaryConstructionError, type CompactArgs, type CompactionResult } from './compaction/compactor.js';
import type { SummarizerProviderPort } from './compaction/summarizer.js';
import { sanitizeRecoveryMessage } from '../../agents/invocation-recovery-policy.js';
import type { ChildInvocationReservation, ExactWaitBarrier, ExecutingLlmActivity, ExternalAndProcessWaits, LlmToolInvocationContext, ToolInvocationIdentity } from './executing-llm-snapshot.js';
import { ChildInvocationLease } from './child-invocation-wait.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../../contracts/index.js';

export type LLMActorOutcome =
  | { type: 'result'; agentId: string; result: Extract<LlmCompleteResult, { kind: 'message' }> }
  | { type: 'tool_call'; agentId: string; inputId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: 'blocked'; agentId: string; result: ContentPolicyRefusalBlockedResult }
  | { type: 'error'; agentId: string; error: string };

export class LastChanceSummaryProviderUnavailableError extends Error {
  constructor(cause: ProviderTurnFailure) {
    super('Provider unavailable while constructing the last-chance compaction summary.', { cause });
    this.name = 'LastChanceSummaryProviderUnavailableError';
  }
}

export interface LLMProviderPort {
  completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion>;
  projectProviderExchanges?(sessionId: string, sourceInputId: string, attempts: ProviderExchangeAttempt[], context: ProviderExchangePublicationContext): void;
}

export interface CompactorPort {
  shouldCompact(input: PreparedLlmInvocationInput): boolean;
  compact(args: CompactArgs): Promise<CompactionResult>;
}

export type LlmTerminalHandoff = (terminal: Readonly<{ input: CanonicalLlmInvocationInput; outcome: Extract<LLMActorOutcome, { type: 'result' | 'blocked' | 'error' }> }>) => void;

type Callbacks = Readonly<{ terminal: LlmTerminalHandoff }>;
type WaitingToolCall = Readonly<{ sourceInputId: string; toolCallId: string; toolName: string; toolCallArguments: string }>;
type Disposition = { kind: 'open' } | { kind: 'continuation_closed'; reason: unknown } | { kind: 'disposed'; reason: unknown };
type InvocationOperation = {
  input: CanonicalLlmInvocationInput;
  callbacks: Callbacks;
  result: Deferred<LLMActorOutcome>;
  settlement: Deferred<void>;
  signal: AbortSignal;
  lease: InvocationLease | null;
  completionPersistenceEntered: boolean;
  providerBoundaryEntered: boolean;
  disposition: Disposition;
};
type ParkedOperation = {
  input: CanonicalLlmInvocationInput;
  callbacks: Callbacks;
  outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>;
  waiting: WaitingToolCall;
  disposition: Disposition;
  toolContext: LlmToolInvocationContext | null;
  childLease: ChildInvocationLease | null;
};
type RetainedOperation = { input: CanonicalLlmInvocationInput; callbacks: Callbacks; outcome: Extract<LLMActorOutcome, { type: 'result' }>; disposition: Disposition };
type ToolSettlementBase = {
  parked: ParkedOperation;
  settlement: Deferred<void>;
  disposal: { reason: unknown } | null;
};
type OrdinaryToolSettlementOperation = ToolSettlementBase & { kind: 'ordinary_continuation'; result: Deferred<LLMActorOutcome> };
type NoContinuationToolSettlementOperation = ToolSettlementBase & { kind: 'no_continuation'; result: Deferred<void> };
type ToolSettlementOperation = OrdinaryToolSettlementOperation | NoContinuationToolSettlementOperation;
type RepairOperation = { retained: RetainedOperation; result: Deferred<LLMActorOutcome>; settlement: Deferred<void>; disposition: Disposition };
type ConversationPhase =
  | { kind: 'idle'; disposition: Disposition }
  | { kind: 'arming'; operation: InvocationOperation }
  | { kind: 'invoking'; operation: InvocationOperation }
  | { kind: 'waiting_tool'; operation: ParkedOperation }
  | { kind: 'settling_tool'; operation: ToolSettlementOperation }
  | { kind: 'retained_text'; operation: RetainedOperation }
  | { kind: 'repairing_text'; operation: RepairOperation };

export type ConversationDisposalDisposition = 'revoked_before_owned_completion' | 'joining_owned_completion';
export type LLMToolContinuationContextHook = (continuationInputId: string) => { messages: readonly ProviderVisibleUserContextMessage[]; afterAppend?: () => void } | undefined;
export type ConversationLLMActorPurpose = Readonly<
  { kind: 'autonomous-card'; cardId: CardId } | { kind: 'analyst' }
>;

export class ConversationLLMActor {
  readonly agentId: ConversationSessionId;
  readonly purpose: ConversationLLMActorPurpose;
  readonly provider: LLMProviderPort;
  readonly gate: RuntimeGate;
  readonly conversations: ConversationFileContext;
  readonly compactor: CompactorPort;
  readonly summarizerProvider: SummarizerProviderPort;
  readonly runtimeProjectionChanged?: () => void;
  readonly #fatalPort: ApplicationFatalPort;
  readonly #invocations = new InvocationLifecycle();
  readonly #systemPromptLoggedSessionIds = new Set<string>();
  #phase: ConversationPhase = { kind: 'idle', disposition: { kind: 'open' } };
  #executingActivity: ExecutingLlmActivity = Object.freeze({ mode: 'active', barrier: null });

  constructor(args: { purpose: ConversationLLMActorPurpose; agentId: string; provider: LLMProviderPort; conversations: ConversationFileContext; gate?: RuntimeGate; compactor: CompactorPort; summarizerProvider: SummarizerProviderPort; runtimeProjectionChanged?: () => void; fatalPort: ApplicationFatalPort }) {
    this.agentId = parseConversationSessionId(args.agentId);
    const identity = conversationSessionIdentity(this.agentId);
    switch (args.purpose.kind) {
      case 'autonomous-card':
        if (identity.cardId !== args.purpose.cardId) throw new Error(`Autonomous-card LLM actor purpose '${args.purpose.cardId}' does not match session '${this.agentId}'.`);
        break;
      case 'analyst':
        if (identity.cardId !== null) throw new Error(`Analyst LLM actor requires a global session, received '${this.agentId}'.`);
        break;
    }
    this.purpose = Object.freeze(args.purpose);
    this.provider = args.provider;
    this.conversations = args.conversations;
    this.gate = args.gate ?? new RuntimeGate();
    this.compactor = args.compactor;
    this.summarizerProvider = args.summarizerProvider;
    this.runtimeProjectionChanged = args.runtimeProjectionChanged;
    this.#fatalPort = args.fatalPort;
  }

  turn(input: PreparedLlmInvocationInput, signal: AbortSignal | undefined, terminal: LlmTerminalHandoff): Promise<LLMActorOutcome> {
    if (!input.preparedCompaction) return rejected(new Error(`LLMActor '${this.agentId}' requires prepared compaction.`));
    if (input.agentId !== this.agentId) return rejected(new Error(`Input ${input.inputId} targets ${input.agentId}, not ${this.agentId}.`));
    const phase = this.#phase;
    if (phase.kind !== 'idle' && phase.kind !== 'retained_text') return rejected(new Error(`LLMActor '${this.agentId}' cannot start a new turn while '${phase.kind}'.`));
    const disposition = phase.kind === 'idle' ? phase.disposition : phase.operation.disposition;
    if (disposition.kind !== 'open') return rejected(new Error(`LLMActor '${this.agentId}' invocation admission is closed.`));
    return this.#arm(input, signal, { terminal }, disposition);
  }

  waitingToolOutcome(): Extract<LLMActorOutcome, { type: 'tool_call' }> {
    if (this.#phase.kind !== 'waiting_tool') throw new Error(`LLMActor '${this.agentId}' is not waiting for a tool call.`);
    const { waiting, input, outcome } = this.#phase.operation;
    const logged = readLoggedToolCall(this.conversations.projectRoot, input.sessionId, this.agentId, waiting.sourceInputId, waiting.toolCallId);
    if (logged.tool_name !== waiting.toolName) throw new Error(`Logged tool call '${waiting.toolCallId}' tool name changed.`);
    return outcome;
  }

  waitingToolArguments(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): string {
    return this.#requireParked(outcome).waiting.toolCallArguments;
  }

  waitingToolInput(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): CanonicalLlmInvocationInput {
    return this.#requireParked(outcome).input;
  }

  executingActivity(): ExecutingLlmActivity {
    const lease = this.#parkedOperation()?.childLease;
    if (lease?.isWaitingBarrier()) return Object.freeze({ mode: 'waiting', barrier: Object.freeze({ kind: 'child', relationship: lease.relationship }) });
    return this.#executingActivity;
  }

  resetExecutingActivity(): void {
    if (this.#executingActivity.mode === 'waiting' || this.#parkedOperation()?.childLease) throw new Error(`LLMActor '${this.agentId}' cannot reset activity while waiting.`);
    this.#executingActivity = Object.freeze({ mode: 'active', barrier: null });
    this.runtimeProjectionChanged?.();
  }

  toolInvocationContext(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): LlmToolInvocationContext {
    const parked = this.#requireParked(outcome);
    if (parked.toolContext) return parked.toolContext;
    const identity = Object.freeze({ sessionId: this.agentId, sourceInputId: parked.waiting.sourceInputId, toolCallId: parked.waiting.toolCallId, toolName: parked.waiting.toolName });
    const waits = this.#externalAndProcessWaits(identity, parked);
    const childInvocation: ChildInvocationReservation = Object.freeze({ identity, reserveChild: (childCardId: string) => {
      this.#requireExactParked(parked);
      if (parked.childLease) {
        if (parked.childLease.childCardId !== childCardId) throw new Error(`Tool call '${identity.toolCallId}' already reserved child '${parked.childLease.childCardId}'.`);
        return parked.childLease;
      }
      if (this.#executingActivity.mode !== 'active') throw new Error(`LLMActor '${this.agentId}' cannot reserve a child while another wait barrier is active.`);
      parked.childLease = new ChildInvocationLease(identity, childCardId);
      return parked.childLease;
    } });
    parked.toolContext = Object.freeze({ ...identity, waits, childInvocation });
    return parked.toolContext;
  }

  appendToolResult(toolCallId: string, result: ToolResult, signal?: AbortSignal, continuationContextHook?: LLMToolContinuationContextHook): Promise<LLMActorOutcome> {
    const parked = this.#claimParked(toolCallId);
    if (parked instanceof Error) return rejected(parked);
    const direct = deferred<LLMActorOutcome>(); observe(direct.promise);
    const operation: OrdinaryToolSettlementOperation = { kind: 'ordinary_continuation', parked, result: direct, settlement: deferred<void>(), disposal: null };
    observe(operation.settlement.promise);
    this.#phase = { kind: 'settling_tool', operation };
    void this.#runToolSettlement(operation, result, signal, continuationContextHook);
    return direct.promise;
  }

  settleToolResultWithoutContinuation(toolCallId: string, result: ToolResult): Promise<void> {
    const parked = this.#claimParked(toolCallId, true);
    if (parked instanceof Error) return rejectedVoid(parked);
    const direct = deferred<void>(); observe(direct.promise);
    const operation: NoContinuationToolSettlementOperation = { kind: 'no_continuation', parked, result: direct, settlement: deferred<void>(), disposal: null };
    observe(operation.settlement.promise);
    this.#phase = { kind: 'settling_tool', operation };
    try {
      this.#appendClaimedToolResult(operation, result);
      if (operation.disposal) {
        this.#settleDisposedTool(operation);
        return direct.promise;
      }
      this.#releaseTool(operation);
      operation.result.resolve();
      operation.settlement.resolve();
      return direct.promise;
    } catch (error) { this.#deliverPublicationFatal(error); this.#failTool(operation, error); return direct.promise; }
  }

  continueAfterPlainText(repairDirective: string, signal: AbortSignal | undefined, terminal: LlmTerminalHandoff, continuationContextHook?: LLMToolContinuationContextHook): Promise<LLMActorOutcome> {
    if (this.#phase.kind !== 'retained_text' || this.#phase.operation.disposition.kind !== 'open') return rejected(new Error(`LLMActor '${this.agentId}' has no open plain-text result to continue.`));
    const retained = this.#phase.operation;
    const direct = deferred<LLMActorOutcome>(); observe(direct.promise);
    const repair: RepairOperation = { retained, result: direct, settlement: deferred<void>(), disposition: retained.disposition }; observe(repair.settlement.promise);
    this.#phase = { kind: 'repairing_text', operation: repair };
    try {
      signal?.throwIfAborted();
      const inputId = randomUUID();
      const input = { ...retained.input, inputId };
      const repairMessage = appendModelRepairMessage(this.conversations, input, repairDirective);
      this.#assertRepairOpen(repair);
      const continuation = continuationContextHook?.(inputId);
      this.#assertRepairOpen(repair);
      const contextRows = (continuation?.messages ?? []).map((message, index) => buildUserContextMessage(input.sessionId, inputId, 'continuation_hook', index, message));
      if (contextRows.length > 0) appendConversationBatch(this.conversations, contextRows);
      this.#assertRepairOpen(repair);
      continuation?.afterAppend?.();
      this.#assertRepairOpen(repair);
      const next = { ...input, providerConversation: providerConversationProjection(readConversation(this.conversations.projectRoot, input.sessionId)), episodeContext: { ...input.episodeContext, lastModelRepair: repairMessage.id } };
      this.#assertRepairOpen(repair);
      repair.settlement.resolve();
      const nested = this.#arm(next, signal, { terminal }, repair.disposition);
      nested.then(repair.result.resolve, (error: unknown) => repair.result.reject(asError(error)));
    } catch (error) {
      this.#deliverPublicationFatal(error);
      {
        this.#phase = { kind: 'idle', disposition: repair.disposition }; repair.result.reject(asError(error)); repair.settlement.reject(asError(error));
      }
    }
    return direct.promise;
  }

  claimResultAndCloseContinuation(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>, reason: unknown, claim: () => void): void {
    const parked = this.#requireParked(outcome);
    claim();
    parked.disposition = { kind: 'continuation_closed', reason };
  }

  abandonParkedTurn(): void {
    if (this.#phase.kind === 'idle') return;
    if (this.#phase.kind !== 'waiting_tool') throw new Error(`LLMActor '${this.agentId}' cannot abandon '${this.#phase.kind}'.`);
    const parked = this.#phase.operation;
    if (parked.childLease) throw new Error(`LLMActor '${this.agentId}' cannot abandon a turn with a child invocation lease.`);
    this.#phase = { kind: 'idle', disposition: parked.disposition };
  }

  dispose(reason: unknown): ConversationDisposalDisposition {
    this.#invocations.closeAdmission(reason);
    const phase = this.#phase;
    if (phase.kind === 'idle') { this.#phase = { kind: 'idle', disposition: { kind: 'disposed', reason } }; return 'revoked_before_owned_completion'; }
    if (phase.kind === 'retained_text') { this.#phase = { kind: 'idle', disposition: { kind: 'disposed', reason } }; return 'revoked_before_owned_completion'; }
    if (phase.kind === 'waiting_tool') {
      const lease = phase.operation.childLease;
      phase.operation.disposition = { kind: 'disposed', reason };
      if (lease?.phase() === 'reserved') { lease.markRejected(); lease.deliverInterruption(asError(reason)); }
      if (!lease || lease.phase() === 'rejected') { this.#phase = { kind: 'idle', disposition: phase.operation.disposition }; return 'revoked_before_owned_completion'; }
      return 'joining_owned_completion';
    }
    if (phase.kind === 'arming' || (phase.kind === 'invoking' && !phase.operation.completionPersistenceEntered)) {
      const operation = phase.operation;
      operation.disposition = { kind: 'disposed', reason };
      this.#invocations.revoke(reason); this.#phase = { kind: 'idle', disposition: { kind: 'disposed', reason } };
      operation.result.reject(asError(reason)); operation.settlement.reject(asError(reason));
      return 'revoked_before_owned_completion';
    }
    if (phase.kind === 'settling_tool') {
      if (!phase.operation.disposal) {
        phase.operation.disposal = { reason };
        phase.operation.parked.disposition = { kind: 'disposed', reason };
      }
    }
    else phase.operation.disposition = { kind: 'disposed', reason };
    return 'joining_owned_completion';
  }

  suppressContinuation(reason: unknown): void {
    this.#invocations.closeAdmission(reason);
    const phase = this.#phase;
    if (phase.kind === 'waiting_tool') { phase.operation.disposition = { kind: 'continuation_closed', reason }; return; }
    if (phase.kind === 'idle') { this.#phase = { kind: 'idle', disposition: { kind: 'continuation_closed', reason } }; return; }
    if (phase.kind === 'retained_text') { phase.operation.disposition = { kind: 'continuation_closed', reason }; return; }
    if (phase.kind === 'arming' || phase.kind === 'invoking') { phase.operation.disposition = { kind: 'continuation_closed', reason }; return; }
    if (phase.kind === 'settling_tool') { phase.operation.parked.disposition = { kind: 'continuation_closed', reason }; return; }
    if (phase.kind === 'repairing_text') { phase.operation.disposition = { kind: 'continuation_closed', reason }; return; }
    throw new Error(`LLMActor '${this.agentId}' has an unknown continuation phase.`);
  }

  async join(): Promise<InvocationJoinOutcome> {
    const phase = this.#phase;
    const settlements: Promise<unknown>[] = [];
    if (phase.kind === 'arming' || phase.kind === 'invoking' || phase.kind === 'settling_tool' || phase.kind === 'repairing_text') settlements.push(phase.operation.settlement.promise);
    const parked = this.#parkedOperation(); if (parked?.childLease) settlements.push(parked.childLease.join());
    const invocationJoin = this.#invocations.join();
    const all = await Promise.allSettled([...settlements, invocationJoin]);
    const publicationFailure = all.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected' && entry.reason instanceof PublicationOutcomeUnknownError);
    if (publicationFailure) this.#fatalPort.publicationOutcomeUnknown(publicationFailure.reason);
    const failure = all.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
    if (failure) throw failure.reason;
    return (all[all.length - 1] as PromiseFulfilledResult<InvocationJoinOutcome>).value;
  }

  assertInvocationCanHandoff(): void { if (this.#parkedOperation()?.childLease) throw new Error(`LLMActor '${this.agentId}' cannot hand off with a child invocation lease.`); }
  #arm(input: CanonicalLlmInvocationInput, signal: AbortSignal | undefined, callbacks: Callbacks, disposition: Disposition): Promise<LLMActorOutcome> {
    const result = deferred<LLMActorOutcome>(); observe(result.promise);
    const settlement = deferred<void>(); observe(settlement.promise);
    const operation: InvocationOperation = { input, callbacks, result, settlement, signal: signal ?? new AbortController().signal, lease: null, completionPersistenceEntered: false, providerBoundaryEntered: false, disposition };
    this.#phase = { kind: 'arming', operation };
    try { this.runtimeProjectionChanged?.(); this.#beginInvocation(operation); }
    catch (error) { this.#deliverPublicationFatal(error); this.#failInvocation(operation, error); }
    return result.promise;
  }

  #beginInvocation(operation: InvocationOperation): void {
    if (this.#phase.kind !== 'arming' || this.#phase.operation !== operation) throw new Error('LLM arming authority changed.');
    const lease = this.#invocations.begin(operation.signal); operation.lease = lease; this.#phase = { kind: 'invoking', operation };
    const raw = this.#invocations.runExternal(lease, (signal) => this.#runProvider(operation, signal));
    void this.#invocations.trackConsumer(async () => {
      try { await this.#completeInvocation(operation, await raw); }
       catch (error) { this.#deliverPublicationFatal(error); await this.#rejectInvocation(operation, error); }
    });
  }

  async #runProvider(operation: InvocationOperation, signal: AbortSignal): Promise<PersistedProviderCompletion> {
    let input = operation.input;
    if (!input.preparedCompaction) throw new Error(`LLMActor '${this.agentId}' admitted an invocation without prepared compaction.`);
    this.#assertPersistenceOwnership(input);
    if (this.compactor.shouldCompact(input)) {
      const compacted = await this.compactor.compact({ strategy: 'preventive', conversations: this.conversations, input, summarizerProvider: this.summarizerProvider, signal });
      signal.throwIfAborted();
      if (compacted.kind !== 'compacted') throw new Error('Preventive compaction returned no_smaller_projection.');
      if (compacted.providerConversation.sourceSessionId !== input.providerConversation.sourceSessionId) throw new Error(`Compaction changed provider conversation source session from '${input.providerConversation.sourceSessionId}' to '${compacted.providerConversation.sourceSessionId}'.`);
      input = { ...input, providerConversation: compacted.providerConversation }; operation.input = input;
    }
    this.#assertPersistenceOwnership(input);
    const includeSystemPrompt = !this.#systemPromptLoggedSessionIds.has(input.sessionId);
    appendLlmTurnStarted(this.conversations, input, { includeSystemPrompt });
    if (includeSystemPrompt) this.#systemPromptLoggedSessionIds.add(input.sessionId);
    await this.gate.waitUntilOpen(signal); this.#invocations.assertCurrent(operation.lease!); operation.providerBoundaryEntered = true;
    const completion = await this.#callProvider(operation, input, signal); this.#invocations.assertCurrent(operation.lease!);
    if (completion.kind === 'content-policy-blocked') return completion;
    operation.completionPersistenceEntered = true;
    return this.#persistProviderCompletion(input, completion.completion);
  }

  async #completeInvocation(operation: InvocationOperation, persisted: PersistedProviderCompletion): Promise<void> {
    try {
      if (this.#phase.kind !== 'invoking' || this.#phase.operation !== operation) throw new Error('Provider completion lost direct operation authority.');
      const outcome = this.#outcomeFromPersisted(persisted);
      if (outcome.type === 'tool_call') {
        const waiting = { sourceInputId: persisted.input.inputId, toolCallId: outcome.toolCallId, toolName: outcome.toolName, toolCallArguments: persisted.toolCallArguments! };
        const parked: ParkedOperation = { input: persisted.input, callbacks: operation.callbacks, outcome, waiting, disposition: operation.disposition, toolContext: null, childLease: null };
        this.#phase = { kind: 'waiting_tool', operation: parked };
      } else {
        operation.callbacks.terminal(Object.freeze({ input: persisted.input, outcome }));
        this.#phase = outcome.type === 'result'
          ? { kind: 'retained_text', operation: { input: persisted.input, callbacks: operation.callbacks, outcome, disposition: operation.disposition } }
          : { kind: 'idle', disposition: operation.disposition };
      }
      this.#invocations.settle(operation.lease!); operation.lease = null;
      operation.result.resolve(outcome); operation.settlement.resolve(); this.runtimeProjectionChanged?.();
    } catch (error) { this.#deliverPublicationFatal(error); this.#failInvocation(operation, error); }
  }

  async #rejectInvocation(operation: InvocationOperation, error: unknown): Promise<void> {
    this.#deliverPublicationFatal(error);
    try {
      if (this.#phase.kind !== 'invoking' || this.#phase.operation !== operation) return;
      if (operation.completionPersistenceEntered) throw error;
      if (operation.signal.aborted || operation.lease === null) throw error;
      if (!operation.providerBoundaryEntered) throw error;
      if (!(error instanceof ProviderTurnFailure)) throw error;
      if (error.failure_phase === 'provider_attempt' && error.provider_exchanges.length === 0) throw new Error(`Provider attempt for '${operation.input.inputId}' failed without provider_exchange envelope.`);
      const message = error.originalFailure instanceof Error ? error.originalFailure.message : error.message;
      operation.completionPersistenceEntered = true;
      const appended = appendLlmTurnError(this.conversations, operation.input, message);
      this.#projectProviderExchanges(operation.input, error.provider_exchanges, { assistantOutputIds: [], terminalConversationOutputId: appended.id });
      const outcome: Extract<LLMActorOutcome, { type: 'error' }> = { type: 'error', agentId: this.agentId, error: message };
      operation.callbacks.terminal(Object.freeze({ input: operation.input, outcome }));
      this.#phase = { kind: 'idle', disposition: operation.disposition };
      this.#invocations.settle(operation.lease!); operation.lease = null;
      operation.result.resolve(outcome); operation.settlement.resolve();
    } catch (fatal) { this.#deliverPublicationFatal(fatal); this.#failInvocation(operation, fatal); }
  }

  #failInvocation(operation: InvocationOperation, error: unknown): void {
    const failure = asError(error);
    if (operation.lease) { try { this.#invocations.cancelCurrent(operation.lease, failure); } catch { /* exact failure remains authoritative */ } operation.lease = null; }
    this.#deliverPublicationFatal(failure);
    if ((this.#phase.kind === 'arming' || this.#phase.kind === 'invoking') && this.#phase.operation === operation) this.#phase = { kind: 'idle', disposition: operation.disposition };
    operation.result.reject(failure); operation.settlement.reject(failure);
  }

  async #runToolSettlement(operation: OrdinaryToolSettlementOperation, result: ToolResult, signal?: AbortSignal, hook?: LLMToolContinuationContextHook): Promise<void> {
    try {
      signal?.throwIfAborted(); this.#appendClaimedToolResult(operation, result);
      if (operation.disposal) return this.#settleDisposedTool(operation);
      let continuationInput = { ...operation.parked.input, inputId: randomUUID(), episodeContext: { ...operation.parked.input.episodeContext, lastToolResult: { toolCallId: operation.parked.waiting.toolCallId, toolName: operation.parked.waiting.toolName, result } } };
      const continuation = hook?.(continuationInput.inputId);
      if (operation.disposal) return this.#settleDisposedTool(operation);
      const contextRows = (continuation?.messages ?? []).map((message, index) => buildUserContextMessage(continuationInput.sessionId, continuationInput.inputId, 'continuation_hook', index, message));
      if (contextRows.length > 0) appendConversationBatch(this.conversations, contextRows);
      if (operation.disposal) return this.#settleDisposedTool(operation);
      continuation?.afterAppend?.();
      if (operation.disposal) return this.#settleDisposedTool(operation);
      continuationInput = { ...continuationInput, providerConversation: providerConversationProjection(readConversation(this.conversations.projectRoot, continuationInput.sessionId)) };
      this.#releaseChild(operation.parked); operation.settlement.resolve();
      const nested = this.#arm(continuationInput, signal, operation.parked.callbacks, operation.parked.disposition);
      nested.then(operation.result.resolve, (error: unknown) => operation.result.reject(asError(error)));
    } catch (error) { this.#deliverPublicationFatal(error); this.#failTool(operation, error); }
  }

  #appendClaimedToolResult(operation: ToolSettlementOperation, result: ToolResult): void {
    appendToolResult(this.conversations, { session_id: operation.parked.input.sessionId, source_input_id: operation.parked.input.inputId, tool_call_id: operation.parked.waiting.toolCallId, tool_name: operation.parked.waiting.toolName, result });
  }

  #settleDisposedTool(operation: ToolSettlementOperation): void {
    if (!operation.disposal) throw new Error('Disposed tool settlement has no disposal claim.');
    const { reason } = operation.disposal;
    this.#releaseTool(operation);
    operation.result.reject(reason);
    operation.settlement.resolve();
  }

  #releaseTool(operation: ToolSettlementOperation): void {
    this.#releaseChild(operation.parked);
    this.#phase = { kind: 'idle', disposition: operation.parked.disposition };
  }

  #failTool(operation: ToolSettlementOperation, error: unknown): void {
    const failure = asError(error);
    this.#deliverPublicationFatal(failure);
    if (this.#phase.kind === 'settling_tool' && this.#phase.operation === operation) this.#phase = { kind: 'idle', disposition: operation.parked.disposition };
    operation.result.reject(failure); operation.settlement.reject(failure);
  }

  #assertRepairOpen(operation: RepairOperation): void {
    if (this.#phase.kind !== 'repairing_text' || this.#phase.operation !== operation) throw new Error('Plain-text repair lost direct operation authority.');
    if (operation.disposition.kind !== 'open') throw asError(operation.disposition.reason);
  }

  #claimParked(toolCallId: string, allowClosed = false): ParkedOperation | Error {
    if (this.#phase.kind !== 'waiting_tool') return new Error(`LLMActor '${this.agentId}' is not waiting for a tool result.`);
    const parked = this.#phase.operation;
    if (parked.waiting.toolCallId !== toolCallId) return new Error(`LLMActor '${this.agentId}' is waiting for '${parked.waiting.toolCallId}', not '${toolCallId}'.`);
    if (parked.disposition.kind === 'disposed' || (!allowClosed && parked.disposition.kind !== 'open')) return new Error(`LLMActor '${this.agentId}' continuation admission is closed.`);
    try { this.#releaseChild(parked); } catch (error) { return asError(error); }
    return parked;
  }

  #releaseChild(parked: ParkedOperation): void {
    if (!parked.childLease) return;
    if (!parked.childLease.isConsumable()) throw new Error(`LLMActor '${this.agentId}' cannot settle tool call '${parked.waiting.toolCallId}' while child lease is '${parked.childLease.phase()}'.`);
    parked.childLease = null; parked.toolContext = null;
  }

  #requireParked(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): ParkedOperation {
    if (this.#phase.kind !== 'waiting_tool') throw new Error(`LLMActor '${this.agentId}' is not waiting for a tool call.`);
    const parked = this.#phase.operation;
    if (outcome.agentId !== this.agentId) throw new Error(`Tool call '${outcome.toolCallId}' belongs to '${outcome.agentId}', not '${this.agentId}'.`);
    if (outcome !== parked.outcome && (outcome.inputId !== parked.input.inputId || outcome.toolCallId !== parked.waiting.toolCallId || outcome.toolName !== parked.waiting.toolName)) throw new Error(`Tool call '${outcome.toolCallId}' does not match the current delivered call.`);
    return parked;
  }
  #requireExactParked(parked: ParkedOperation): void { if (this.#phase.kind !== 'waiting_tool' || this.#phase.operation !== parked) throw new Error(`Tool invocation is no longer current for '${this.agentId}'.`); }
  #parkedOperation(): ParkedOperation | null { return this.#phase.kind === 'waiting_tool' ? this.#phase.operation : this.#phase.kind === 'settling_tool' ? this.#phase.operation.parked : null; }

  #externalAndProcessWaits(identity: ToolInvocationIdentity, parked: ParkedOperation): ExternalAndProcessWaits {
    const wait = async <T>(barrier: ExactWaitBarrier, promise: Promise<T>): Promise<T> => {
      this.#requireExactParked(parked);
      if (this.#executingActivity.mode !== 'active' || parked.childLease?.isWaitingBarrier()) throw new Error(`LLMActor '${this.agentId}' already owns a wait barrier.`);
      this.#executingActivity = Object.freeze({ mode: 'waiting', barrier: Object.freeze(barrier) }); this.#publishExecutingActivityChange();
      let awaitedCompletion: { kind: 'success'; value: T } | { kind: 'failure'; reason: unknown };
      try { awaitedCompletion = { kind: 'success', value: await promise }; }
      catch (error) { this.#deliverPublicationFatal(error); awaitedCompletion = { kind: 'failure', reason: error }; }
      let settlementCompletion: { kind: 'success' } | { kind: 'failure'; reason: unknown };
      try {
        if (this.#executingActivity.mode !== 'waiting' || this.#executingActivity.barrier !== barrier) throw new Error(`LLMActor '${this.agentId}' wait barrier changed before settlement.`);
        this.#executingActivity = Object.freeze({ mode: 'active', barrier: null });
        this.#publishExecutingActivityChange();
        settlementCompletion = { kind: 'success' };
      } catch (error) {
        settlementCompletion = { kind: 'failure', reason: error };
      }
      if (settlementCompletion.kind === 'failure') throw settlementCompletion.reason;
      if (awaitedCompletion.kind === 'failure') throw awaitedCompletion.reason;
      return awaitedCompletion.value;
    };
    return Object.freeze({ waitExternal: <T>(promise: Promise<T>) => wait({ kind: 'external', ...identity }, promise), waitProcess: <T>(processId: string, promise: Promise<T>) => wait({ kind: 'process', ...identity, processId }, promise) });
  }
  #publishExecutingActivityChange(): void { this.runtimeProjectionChanged?.(); }
  #assertPersistenceOwnership(input: CanonicalLlmInvocationInput): void { if (input.sessionId !== input.providerConversation.sourceSessionId) throw new Error(`Persisted LLM invocation '${input.inputId}' session '${input.sessionId}' does not match provider conversation source session '${input.providerConversation.sourceSessionId}'.`); }

  async #callProvider(operation: InvocationOperation, input: CanonicalLlmInvocationInput, signal: AbortSignal): Promise<{ kind: 'completion'; completion: ProviderTurnCompletion } | Extract<PersistedProviderCompletion, { kind: 'content-policy-blocked' }>> {
    let firstFailure: AuthoritativeContextFailure;
    try { return { kind: 'completion', completion: await this.provider.completeTurn(input, signal) }; }
    catch (error) {
      if (isAuthoritativeContentPolicyFailure(error)) return this.#recoverContentPolicyRefusal(operation, input, signal, error);
      if (!isAuthoritativeContextFailure(error)) throw error;
      firstFailure = error;
    }
    if (!operation.providerBoundaryEntered || operation.completionPersistenceEntered) throw new Error(`LLMActor '${this.agentId}' cannot recover outside the provider boundary.`);
    const firstAttempts = strictContextFailureAttempts(firstFailure, input.inputId); signal.throwIfAborted();
    let compaction: Extract<CompactionResult, { kind: 'compacted' }>;
    try {
      if (!input.preparedCompaction) throw new Error(`Context recovery for '${input.inputId}' requires prepared compaction.`);
      const result = await this.compactor.compact({ strategy: 'authoritative_context_recovery', conversations: this.conversations, input: input as PreparedLlmInvocationInput, summarizerProvider: this.summarizerProvider, signal }); signal.throwIfAborted();
      if (result.kind === 'no_smaller_projection') throw normalContextFailure('Provider input context exhausted; last-chance compaction found no strictly smaller safe provider projection, so no provider retry was attempted.', firstAttempts, firstFailure.originalFailure);
      compaction = result;
    } catch (error) {
      this.#deliverPublicationFatal(error);
      if (error instanceof ProviderTurnFailure) {
        this.#projectProviderExchanges(input, firstAttempts, {
          assistantOutputIds: [],
          terminalConversationOutputId: null,
        });
        throw new LastChanceSummaryProviderUnavailableError(error);
      }
      if (error instanceof CompactionSummaryConstructionError) throw normalContextFailure(`Provider input context exhausted; last-chance compaction failed while constructing a smaller projection: ${sanitizeRecoveryMessage(error.cause)}. No provider retry was attempted.`, firstAttempts, firstFailure.originalFailure, error.cause);
      if (error instanceof CompactionAppendError) throw error.cause;
      throw error;
    }
    if (compaction.providerConversation.sourceSessionId !== input.providerConversation.sourceSessionId) throw new Error(`Compaction changed provider conversation source session from '${input.providerConversation.sourceSessionId}' to '${compaction.providerConversation.sourceSessionId}'.`);
    try {
      const completion = await this.provider.completeTurn({ ...input, providerConversation: compaction.providerConversation }, signal);
      return { kind: 'completion', completion: { ...completion, provider_exchanges: combineProviderAttempts(input.inputId, firstAttempts, completion.provider_exchanges) } };
    } catch (error) {
      this.#deliverPublicationFatal(error);
      if (!(error instanceof ProviderTurnFailure)) throw error;
      if (isAuthoritativeContextFailure(error)) {
        const secondAttempts = strictContextFailureAttempts(error, input.inputId);
        throw normalContextFailure(`Provider input context remained exhausted after one forced compacted retry (first_pass_attempts=${firstAttempts.length}, second_pass_attempts=${secondAttempts.length}, compacted_estimated_message_tokens=${compaction.estimatedProviderMessageTokens}).`, combineProviderAttempts(input.inputId, firstAttempts, secondAttempts), error.originalFailure);
      }
      throw new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: combineProviderAttempts(input.inputId, firstAttempts, error.provider_exchanges), originalFailure: error.originalFailure, message: error.message, candidate:error.candidate });
    }
  }

  async #recoverContentPolicyRefusal(operation: InvocationOperation, input: CanonicalLlmInvocationInput, signal: AbortSignal, firstFailure: AuthoritativeContentPolicyFailure): Promise<{ kind: 'completion'; completion: ProviderTurnCompletion } | Extract<PersistedProviderCompletion, { kind: 'content-policy-blocked' }>> {
    switch (this.purpose.kind) {
      case 'analyst': throw firstFailure;
      case 'autonomous-card': break;
    }
    if (!operation.providerBoundaryEntered || operation.completionPersistenceEntered) throw new Error(`LLMActor '${this.agentId}' cannot recover content policy outside the provider boundary.`);
    if (!firstFailure.candidate) throw new Error(`Content-policy failure for '${input.inputId}' is missing its refusing candidate.`);
    const firstAttempts = strictContentPolicyFailureAttempts(firstFailure, input.inputId);
    signal.throwIfAborted();
    appendConversationBatch(this.conversations, [buildContentPolicyRetryMessage(input.sessionId, input.inputId)]);
    const retryInput: CanonicalLlmInvocationInput = {
      ...input,
      providerConversation: providerConversationProjection(readConversation(this.conversations.projectRoot, input.sessionId)),
      routePass: { kind: 'pinned-content-policy-retry', candidate: firstFailure.candidate },
    };
    operation.input = retryInput;
    try {
      const completion = await this.provider.completeTurn(retryInput, signal);
      return { kind: 'completion', completion: { ...completion, provider_exchanges: combineProviderAttempts(input.inputId, firstAttempts, completion.provider_exchanges) } };
    } catch (error) {
      this.#deliverPublicationFatal(error);
      if (!(error instanceof ProviderTurnFailure)) throw error;
      const combined = combineProviderAttempts(input.inputId, firstAttempts, error.provider_exchanges);
      if (!isAuthoritativeContentPolicyFailure(error)) {
        throw new ProviderTurnFailure({ failure_phase: combined.length > 0 ? 'provider_attempt' : error.failure_phase, provider_exchanges: combined, originalFailure: error.originalFailure, message: error.message, candidate: error.candidate });
      }
      strictContentPolicyFailureAttempts(error, input.inputId);
      if (!error.candidate || !sameCandidate(error.candidate, firstFailure.candidate)) throw new Error(`Pinned content-policy retry for '${input.inputId}' did not preserve the refusing candidate.`);
      operation.completionPersistenceEntered = true;
      const marker = buildContentPolicyRefusalMessage({ sessionId: input.sessionId, sourceInputId: input.inputId, candidate: firstFailure.candidate, providerResponse: error.originalFailure.failure.providerResponse });
      appendConversationBatch(this.conversations, [marker]);
      this.#projectProviderExchanges(input, combined, { assistantOutputIds: [], terminalConversationOutputId: marker.id });
      const result: ContentPolicyRefusalBlockedResult = { kind: 'content-policy-refusal', summary: CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY, session_id: input.sessionId, marker_id: marker.id, evidence_url: `/agents/${encodeURIComponent(input.sessionId)}?entry=${encodeURIComponent(marker.id)}` };
      return { kind: 'content-policy-blocked', input, result, toolCallArguments: null };
    }
  }

  #persistProviderCompletion(input: CanonicalLlmInvocationInput, completion: ProviderTurnCompletion): PersistedProviderCompletion {
    const result = completion.result;
    if (result.kind === 'message') { const appended = appendLlmTurnMessageBatch(this.conversations, input, result.content, completion.provider_private_context); this.#projectProviderExchanges(input, completion.provider_exchanges, { assistantOutputIds: [appended.id], terminalConversationOutputId: null }); return { kind: 'message', input, result, toolCallArguments: null }; }
    if (result.tool_calls.length !== 1) { const error = `Provider returned ${result.tool_calls.length} tool calls; exactly one supported tool call is required.`; const appended = appendLlmTurnError(this.conversations, input, error); this.#projectProviderExchanges(input, completion.provider_exchanges, { assistantOutputIds: [appended.id], terminalConversationOutputId: null }); return { kind: 'error', input, error, toolCallArguments: null }; }
    const call = result.tool_calls[0]!; const appended = appendLlmTurnToolCallBatch(this.conversations, input, call, completion.provider_private_context); this.#projectProviderExchanges(input, completion.provider_exchanges, { assistantOutputIds: [appended.id], terminalConversationOutputId: null });
    return { kind: 'tool_call', input, result, toolCallArguments: call.function.arguments };
  }
  #projectProviderExchanges(input: CanonicalLlmInvocationInput, attempts: ProviderExchangeAttempt[], context: ProviderExchangePublicationContext): void { if (attempts.length === 0) return; if (!this.provider.projectProviderExchanges) throw new Error(`Provider for '${input.inputId}' returned provider exchanges without a projection capability.`); this.provider.projectProviderExchanges(input.sessionId, input.inputId, attempts, context); }
  #deliverPublicationFatal(error: unknown): void { if (error instanceof PublicationOutcomeUnknownError) this.#fatalPort.publicationOutcomeUnknown(error); }
  #outcomeFromPersisted(persisted: PersistedProviderCompletion): LLMActorOutcome {
    if (persisted.kind === 'content-policy-blocked') return { type: 'blocked', agentId: this.agentId, result: persisted.result };
    if (persisted.kind === 'message') return { type: 'result', agentId: this.agentId, result: persisted.result };
    if (persisted.kind === 'error') return { type: 'error', agentId: this.agentId, error: persisted.error };
    const call = persisted.result.tool_calls[0]!; return { type: 'tool_call', agentId: this.agentId, inputId: persisted.input.inputId, toolCallId: call.id, toolName: call.function.name, args: parseToolArguments(call.function.arguments) };
  }
}

type PersistedProviderCompletion =
  | { kind: 'message'; input: CanonicalLlmInvocationInput; result: Extract<LlmCompleteResult, { kind: 'message' }>; toolCallArguments: null }
  | { kind: 'tool_call'; input: CanonicalLlmInvocationInput; result: Extract<LlmCompleteResult, { kind: 'tool_calls' }>; toolCallArguments: string }
  | { kind: 'error'; input: CanonicalLlmInvocationInput; error: string; toolCallArguments: null }
  | { kind: 'content-policy-blocked'; input: CanonicalLlmInvocationInput; result: ContentPolicyRefusalBlockedResult; toolCallArguments: null };
type AuthoritativeContextFailure = ProviderTurnFailure & { originalFailure: LlmRequestError & { failure: Extract<LlmTransportFailure, { kind: 'input_context_exhausted' }> } };
function isAuthoritativeContextFailure(error: unknown): error is AuthoritativeContextFailure { return error instanceof ProviderTurnFailure && error.originalFailure instanceof LlmRequestError && error.originalFailure.failure.kind === 'input_context_exhausted'; }
type AuthoritativeContentPolicyFailure = ProviderTurnFailure & { originalFailure: LlmRequestError & { failure: Extract<LlmTransportFailure, { kind: 'content_policy' }> } };
function isAuthoritativeContentPolicyFailure(error: unknown): error is AuthoritativeContentPolicyFailure { return error instanceof ProviderTurnFailure && error.originalFailure instanceof LlmRequestError && error.originalFailure.failure.kind === 'content_policy'; }
function strictContextFailureAttempts(error: ProviderTurnFailure, inputId: string): ProviderExchangeAttempt[] {
  if (error.failure_phase !== 'provider_attempt' || error.provider_exchanges.length === 0) throw new Error(`Context failure for '${inputId}' carried no provider exchange.`);
  return error.provider_exchanges.map((attempt, index) => {
    if (attempt.status !== 'error' || attempt.terminal_tool_fired !== null || attempt.source_input_id !== inputId || attempt.attempt_index !== index) throw new Error(`Context failure for '${inputId}' carried contradictory provider-exchange metadata.`);
    return attempt;
  });
}
function strictContentPolicyFailureAttempts(error: AuthoritativeContentPolicyFailure, inputId: string): ProviderExchangeAttempt[] {
  if (error.failure_phase !== 'provider_attempt' || error.provider_exchanges.length === 0) throw new Error(`Content-policy failure for '${inputId}' carried no provider exchange.`);
  return error.provider_exchanges.map((attempt, index) => {
    if (attempt.status !== 'error' || attempt.terminal_tool_fired !== null || attempt.source_input_id !== inputId || attempt.attempt_index !== index) throw new Error(`Content-policy failure for '${inputId}' carried contradictory provider-exchange metadata.`);
    return attempt;
  });
}
function sameCandidate(left: import('../../contracts/provider-candidate.js').Candidate, right: import('../../contracts/provider-candidate.js').Candidate): boolean { return left.provider === right.provider && left.account === right.account && left.model === right.model; }
function combineProviderAttempts(inputId: string, ...passes: ProviderExchangeAttempt[][]): ProviderExchangeAttempt[] { return passes.flat().map((attempt, attempt_index) => ({ ...attempt, source_input_id: inputId, attempt_index })); }
function normalContextFailure(message: string, attempts: ProviderExchangeAttempt[], classifiedFailure: LlmRequestError, cause?: unknown): ProviderTurnFailure { const originalFailure = new LlmRequestError({ ...classifiedFailure.failure, message }); if (cause !== undefined) originalFailure.cause = cause; return new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: attempts, originalFailure,candidate:null }); }
function parseToolArguments(raw: string): unknown { try { return JSON.parse(raw) as unknown; } catch { return raw; } }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function observe<T>(promise: Promise<T>): void { void promise.catch(() => undefined); }
function rejected(error: Error): Promise<LLMActorOutcome> { const promise = Promise.reject<LLMActorOutcome>(error); observe(promise); return promise; }
function rejectedVoid(error: Error): Promise<void> { const promise = Promise.reject<void>(error); observe(promise); return promise; }
