import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import { ProviderTurnFailure, type LlmCompleteResult, type ProviderTurnCompletion } from '../../agents/llm-contracts.js';
import { LlmRequestError, type LlmTransportFailure } from '../../contracts/llm-failure.js';
import type { AgentMessage } from '../../schemas/index.js';
import type { LlmInvocationInput, PreparedLlmInvocationInput } from './llm-invocation.js';
import { actorKindFromId } from './ids.js';
import { appendLlmTurnError, appendLlmTurnMessageBatch, appendLlmTurnStarted, appendLlmTurnToolCallBatch, appendModelRepairMessage, appendToolResult, readLoggedToolCall } from './llm-delivery-log.js';
import { appendUserContextMessage, readConversationMessages, providerConversationProjection, type ProviderVisibleUserContextMessage } from './conversation-session.js';
import type { ToolResult } from '../../tools/invocation.js';
import { RuntimeGate } from '../runtime-gate.js';
import { deferred, type Deferred } from './deferred.js';
import type { ConversationChangePublisher } from './conversation-publisher.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';
import { InvocationLifecycle, type InvocationJoinOutcome, type InvocationLease } from './invocation-lifecycle.js';
import { providerExchangePayloadSchema, type ProviderExchangeAttempt } from '../../contracts/provider-exchange.js';
import { isRuntimeStoppedInterruption } from './runtime-stopped-interruption.js';
import { CompactionAppendError, CompactionSummaryConstructionError, type CompactArgs, type CompactionResult } from './compaction/compactor.js';
import { SummarizerExchangeProjectionError, type SummarizerProviderPort } from './compaction/summarizer.js';
import { sanitizeRecoveryMessage } from '../../agents/invocation-recovery-policy.js';

export type LLMActorOutcome =
  | { type: 'result'; agentId: string; result: Extract<LlmCompleteResult, { kind: 'message' }> }
  | { type: 'tool_call'; agentId: string; inputId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: 'error'; agentId: string; error: string };

export interface LLMProviderPort {
  completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion>;
  projectProviderExchanges?(sessionId: string, sourceInputId: string, attempts: ProviderExchangeAttempt[], assistantOutputIds: string[]): void;
}

export interface CompactorPort {
  shouldCompact(input: PreparedLlmInvocationInput): boolean;
  compact(args: CompactArgs): Promise<CompactionResult>;
}

type PersistedProviderCompletion =
  | { kind: 'message'; input: LlmInvocationInput; completion: ProviderTurnCompletion; appended: ReturnType<typeof appendLlmTurnMessageBatch> }
  | { kind: 'tool_call'; input: LlmInvocationInput; completion: ProviderTurnCompletion; appended: ReturnType<typeof appendLlmTurnToolCallBatch> }
  | { kind: 'invalid_tool_calls'; input: LlmInvocationInput; completion: ProviderTurnCompletion; error: string; appended: ReturnType<typeof appendLlmTurnError> };

type WaitingToolCall = {
  sourceInputId: string;
  toolCallId: string;
  toolName: string;
  toolCallArguments: string;
};

type TurnStateUpdate = {
  input: LlmInvocationInput;
  waitingToolCall: WaitingToolCall | null;
};

export type LLMToolContinuationContextHook = (continuationInputId: string) => { messages: readonly ProviderVisibleUserContextMessage[]; afterAppend?: () => void } | undefined;

export class ConversationLLMActor extends BaseActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { turn: 'calling_provider' } },
      calling_provider: { on: { done: 'idle', failed: 'idle', tool_call: 'waiting_tool' } },
      waiting_tool: { parked: true, on: { turn: 'calling_provider', abandon: 'idle' } },
    },
  };

  readonly projectRoot: string;
  readonly agentId: string;
  readonly provider: LLMProviderPort;
  readonly gate: RuntimeGate;
  input: LlmInvocationInput | null = null;
  outcome: LLMActorOutcome | null = null;
  waitingToolCall: WaitingToolCall | null = null;
  deliveredToolCallIds = new Set<string>();
  #result: Deferred<LLMActorOutcome> | null = null;
  #activationSignal: AbortSignal | null = null;
  #currentInvocationSignal: AbortSignal | null = null;
  #systemPromptLoggedSessionIds = new Set<string>();
  #providerBoundaryEntered = false;
  #completionPersistenceEntered = false;
  readonly #invocations = new InvocationLifecycle();
  #currentInvocation: InvocationLease | null = null;

  readonly conversationPublisher?: ConversationChangePublisher;
  readonly conversations: ConversationFileContext;
  readonly compactor: CompactorPort;
  readonly summarizerProvider: SummarizerProviderPort;
  readonly runtimeProjectionChanged?: () => void;

  constructor(args: { projectRoot: string; agentId: string; provider: LLMProviderPort; conversations: ConversationFileContext; gate?: RuntimeGate; compactor: CompactorPort; summarizerProvider: SummarizerProviderPort; conversationPublisher?: ConversationChangePublisher; runtimeProjectionChanged?: () => void }) {
    super();
    if (actorKindFromId(args.agentId) !== 'llm') throw new Error(`LLMActor requires an LLM actor id: ${args.agentId}`);
    this.projectRoot = args.projectRoot;
    this.agentId = args.agentId;
    this.provider = args.provider;
    this.conversations = args.conversations;
    this.gate = args.gate ?? new RuntimeGate();
    this.conversationPublisher = args.conversationPublisher;
    this.compactor = args.compactor;
    this.summarizerProvider = args.summarizerProvider;
    this.runtimeProjectionChanged = args.runtimeProjectionChanged;
  }

  turn(input: PreparedLlmInvocationInput, signal?: AbortSignal): Promise<LLMActorOutcome> {
    if (!input.preparedCompaction) return Promise.reject(new Error(`LLMActor '${this.agentId}' requires prepared compaction.`));
    if (input.agentId !== this.agentId) return Promise.reject(new Error(`Input ${input.inputId} targets ${input.agentId}, not ${this.agentId}.`));
    if (this.#result) return Promise.reject(new Error(`LLMActor '${this.agentId}' already has a pending turn.`));
    if (this.state() !== 'idle') return Promise.reject(new Error(`LLMActor '${this.agentId}' cannot start a new turn from '${this.state()}'.`));
    return this.startProviderTurn(input, { resetDeliveredToolCalls: true, signal });
  }

  awaitPendingTurn(): Promise<LLMActorOutcome> {
    if (!this.#result) return Promise.reject(new Error(`LLMActor '${this.agentId}' has no pending provider turn.`));
    return this.#result.promise;
  }

  waitingToolOutcome(): Extract<LLMActorOutcome, { type: 'tool_call' }> {
    if (this.state() !== 'waiting_tool' || !this.waitingToolCall || !this.input) throw new Error(`LLMActor '${this.agentId}' is not waiting for a tool call.`);
    const logged = readLoggedToolCall(this.projectRoot, this.input.sessionId, this.agentId, this.waitingToolCall.sourceInputId, this.waitingToolCall.toolCallId);
    if (logged.tool_name !== this.waitingToolCall.toolName) throw new Error(`Logged tool call '${this.waitingToolCall.toolCallId}' tool name changed from '${this.waitingToolCall.toolName}' to '${logged.tool_name}'.`);
    return { type: 'tool_call', agentId: this.agentId, inputId: this.waitingToolCall.sourceInputId, toolCallId: this.waitingToolCall.toolCallId, toolName: this.waitingToolCall.toolName, args: logged.args };
  }

  appendToolResult(toolCallId: string, result: ToolResult, signal?: AbortSignal, continuationContextHook?: LLMToolContinuationContextHook): Promise<LLMActorOutcome> {
    signal?.throwIfAborted();
    let waiting: WaitingToolCall;
    try {
      waiting = this.requireWaitingTool(toolCallId);
    } catch (error) {
      return Promise.reject(error);
    }
    this.recordToolSettled(toolCallId);
    const input = this.requireInput();
    const delivery = appendToolResult(this.conversations, {
      session_id: input.sessionId,
      source_input_id: waiting.sourceInputId,
      tool_call_id: toolCallId,
      tool_name: waiting.toolName,
      result,
    });
    this.conversationPublisher?.entryAppended(delivery.message);
    const continuationInputId = randomUUID();
    this.appendContinuationContext(input, continuationInputId, continuationContextHook);
    this.input = {
      ...input,
      inputId: continuationInputId,
      providerConversation: providerConversationProjection(readConversationMessages(this.projectRoot, input.sessionId)),
      episodeContext: { ...input.episodeContext, lastToolResult: { toolCallId, toolName: waiting.toolName, result } },
    };
    this.waitingToolCall = null;
    this.onTurnStateUpdated({ input: this.input, waitingToolCall: null });
    return this.continueAfterTool(undefined, signal);
  }

  settleToolResultWithoutContinuation(toolCallId: string, result: ToolResult): void {
    const waiting = this.requireWaitingTool(toolCallId);
    this.recordToolSettled(toolCallId);
    const input = this.requireInput();
    const delivery = appendToolResult(this.conversations, {
      session_id: input.sessionId,
      source_input_id: waiting.sourceInputId,
      tool_call_id: toolCallId,
      tool_name: waiting.toolName,
      result,
    });
    this.conversationPublisher?.entryAppended(delivery.message);
    this.input = null;
    this.outcome = null;
    this.waitingToolCall = null;
    this.#activationSignal = null;
    this.#currentInvocationSignal = null;
    this.onTurnSettled();
    this.deliveredToolCallIds.clear();
    this.parkedSendEvent('abandon');
  }

  continueAfterPlainText(repairDirective: string, signal?: AbortSignal, continuationContextHook?: LLMToolContinuationContextHook): Promise<LLMActorOutcome> {
    signal?.throwIfAborted();
    if (this.state() !== 'idle') return Promise.reject(new Error(`LLMActor '${this.agentId}' cannot continue a plain-text result from '${this.state()}'.`));
    if (this.#result) return Promise.reject(new Error(`LLMActor '${this.agentId}' already has a pending turn.`));
    if (this.outcome?.type !== 'result') return Promise.reject(new Error(`LLMActor '${this.agentId}' has no plain-text result to continue.`));
    const input = this.requireInput();
    const repairInputId = randomUUID();
    const repairMessage = appendModelRepairMessage(this.conversations, { ...input, inputId: repairInputId }, repairDirective);
    this.conversationPublisher?.entryAppended(repairMessage);
    const continuation = continuationContextHook?.(repairInputId);
    const extraMessages = (continuation?.messages ?? []).map((message, index) => {
      const result = appendUserContextMessage(this.conversations, input.sessionId, repairInputId, 'continuation_hook', index, message);
      this.conversationPublisher?.entryAppended(result);
      return result;
    });
    continuation?.afterAppend?.();
    return this.startProviderTurn({
      ...input,
      inputId: repairInputId,
      providerConversation: providerConversationProjection(readConversationMessages(this.projectRoot, input.sessionId)),
      episodeContext: { ...input.episodeContext, lastModelRepair: repairMessage.id },
    }, { resetDeliveredToolCalls: false, signal });
  }

  abandonParkedTurn(): void {
    if (this.state() === 'idle') return;
    if (this.state() !== 'waiting_tool') throw new Error(`LLMActor '${this.agentId}' cannot abandon a turn from '${this.state()}'.`);
    if (this.#result) throw new Error(`LLMActor '${this.agentId}' cannot abandon a pending turn.`);
    this.input = null;
    this.outcome = null;
    this.waitingToolCall = null;
    this.#activationSignal = null;
    this.#currentInvocationSignal = null;
    this.onTurnSettled();
    this.deliveredToolCallIds.clear();
    this.parkedSendEvent('abandon');
  }

  _on_enter__calling_provider(): void {
    this.#providerBoundaryEntered = false;
    this.#completionPersistenceEntered = false;
    try {
      const input = this.requireInput();
      this.runTask(async (signal) => {
        const invocation = this.#invocations.begin(this.createInvocationSignal(signal));
        this.#currentInvocation = invocation;
        const invocationSignal = this.#invocations.signal(invocation);
        this.#currentInvocationSignal = invocationSignal;
        const persisted = await this.#invocations.runExternal(invocation, async (exactSignal) => {
          this.assertPersistenceOwnership(input);
          const hookInput = await this.onBeforeProviderCall(input, exactSignal);
          this.#invocations.assertCurrent(invocation);
          const effectiveInput = hookInput ?? input;
          this.assertPersistenceOwnership(effectiveInput);
          if (hookInput) this.input = effectiveInput;
          const includeSystemPrompt = !this.#systemPromptLoggedSessionIds.has(effectiveInput.sessionId);
          for (const result of appendLlmTurnStarted(this.conversations, effectiveInput, { includeSystemPrompt })) this.conversationPublisher?.entryAppended(result);
          if (includeSystemPrompt) this.#systemPromptLoggedSessionIds.add(effectiveInput.sessionId);
          const providerInput = effectiveInput;
          this.input = providerInput;
          this.onTurnStateUpdated({ input: providerInput, waitingToolCall: null });
          await this.gate.waitUntilOpen(exactSignal);
          this.#invocations.assertCurrent(invocation);
          this.#providerBoundaryEntered = true;
          const completion = await this.callProvider(providerInput, exactSignal);
          this.#invocations.assertCurrent(invocation);
          this.#completionPersistenceEntered = true;
          return this.persistProviderCompletion(providerInput, completion);
        });
        return { invocation, persisted };
      }, {
        on_done: ({ invocation, persisted }) => {
          void this.#invocations.trackConsumer(() => {
            try {
              this.#invocations.assertCurrent(invocation);
              this.completeWithProviderCompletion(persisted);
              this.#invocations.settle(invocation);
              this.#currentInvocation = null;
            } catch (error) {
              this.failPendingTurnFatally(error);
            }
          });
        },
        on_failed: (error) => {
          void this.#invocations.trackConsumer(() => {
            try {
              const invocation = this.#currentInvocation;
              const stopReason = this.runtimeStopReason();
              if (error instanceof PostRejectionFatalError) throw error.fatalCause;
              if (this.isCurrentTurnAborted(error)) {
                const cancellation = stopReason ?? error;
                if (invocation) this.#invocations.cancelCurrent(invocation, cancellation);
                this.#currentInvocation = null;
                this.completeWithCancellation(cancellation instanceof Error ? cancellation : new Error(String(cancellation)));
                return;
              }
              if (this.#completionPersistenceEntered) throw error;
              if (!this.#providerBoundaryEntered) throw error instanceof Error ? error : new Error(String(error));
              this.completeProviderFailure(this.requireInput(), error);
              if (invocation) this.#invocations.settle(invocation);
              this.#currentInvocation = null;
            } catch (fatal) {
              this.failPendingTurnFatally(fatal);
            }
          });
        },
      });
    } catch (error) {
      this.failPendingTurnFatally(error);
    }
  }

  private persistProviderCompletion(input: LlmInvocationInput, completion: ProviderTurnCompletion): PersistedProviderCompletion {
    const result = completion.result;
    if (result.kind === 'message') {
      const appended = appendLlmTurnMessageBatch(this.conversations, input, result.content, completion.provider_private_context);
      this.projectProviderExchanges(input, completion.provider_exchanges, [appended.id]);
      return { kind: 'message', input, completion, appended };
    }
    if (result.tool_calls.length !== 1) {
      const error = `Provider returned ${result.tool_calls.length} tool calls; exactly one supported tool call is required.`;
      const appended = appendLlmTurnError(this.conversations, input, error);
      this.projectProviderExchanges(input, completion.provider_exchanges, [appended.id]);
      return { kind: 'invalid_tool_calls', input, completion, error, appended };
    }
    const [call] = result.tool_calls;
    const appended = appendLlmTurnToolCallBatch(this.conversations, input, call, completion.provider_private_context);
    this.projectProviderExchanges(input, completion.provider_exchanges, [appended.id]);
    return { kind: 'tool_call', input, completion, appended };
  }

  private completeWithProviderCompletion(persisted: PersistedProviderCompletion): void {
    const { input, completion } = persisted;
    const result = completion.result;
    if (persisted.kind === 'message' && result.kind === 'message') {
      this.conversationPublisher?.entryAppended(persisted.appended);
      const activeConversation = readConversationMessages(this.projectRoot, input.sessionId);
      this.input = { ...input, providerConversation: providerConversationProjection(activeConversation) };
      this.outcome = { type: 'result', agentId: this.agentId, result };
      this.onTurnSettled();
      this.#activationSignal = null;
      this.#currentInvocationSignal = null;
      this.#result?.resolve(this.outcome);
      this.#result = null;
      this.sendEvent('done');
      return;
    }
    if (persisted.kind === 'invalid_tool_calls') {
      this.conversationPublisher?.entryAppended(persisted.appended);
      this.settleWithError(persisted.error);
      return;
    }
    if (result.kind !== 'tool_calls') throw new Error('Persisted provider completion kind changed before delivery.');
    const [call] = result.tool_calls;
    this.conversationPublisher?.entryAppended(persisted.appended);
    this.waitingToolCall = { sourceInputId: input.inputId, toolCallId: call.id, toolName: call.function.name, toolCallArguments: call.function.arguments };
    this.onTurnStateUpdated({ input, waitingToolCall: this.waitingToolCall });
    this.outcome = { type: 'tool_call', agentId: this.agentId, inputId: input.inputId, toolCallId: call.id, toolName: call.function.name, args: parseToolArguments(call.function.arguments) };
    this.#currentInvocationSignal = null;
    this.#activationSignal = null;
    this.#result?.resolve(this.outcome);
    this.#result = null;
    this.sendEvent('tool_call');
  }

  private completeWithError(input: LlmInvocationInput, error: string): void {
    this.conversationPublisher?.entryAppended(appendLlmTurnError(this.conversations, input, error));
    this.settleWithError(error);
  }

  private completeProviderFailure(input: LlmInvocationInput, error: unknown): void {
    if (!(error instanceof ProviderTurnFailure)) throw new Error(`Provider boundary for '${input.inputId}' failed without ProviderTurnFailure metadata.`);
    if (error.failure_phase === 'provider_attempt' && error.provider_exchanges.length === 0) throw new Error(`Provider attempt for '${input.inputId}' failed without provider_exchange envelope.`);
    const message = error.originalFailure instanceof Error ? error.originalFailure.message : error.message;
    const appended = appendLlmTurnError(this.conversations, input, message);
    this.conversationPublisher?.entryAppended(appended);
    this.projectProviderExchanges(input, error.provider_exchanges, [appended.id]);
    this.settleWithError(message);
  }

  private projectProviderExchanges(input: LlmInvocationInput, attempts: ProviderExchangeAttempt[], outputIds: string[]): void {
    if (attempts.length === 0) return;
    const project = this.provider.projectProviderExchanges;
    if (!project) throw new Error(`Provider for '${input.inputId}' returned provider exchanges without a projection capability.`);
    project(input.sessionId, input.inputId, attempts, outputIds);
  }

  private settleWithError(error: string): void {
    this.outcome = { type: 'error', agentId: this.agentId, error };
    this.onTurnSettled();
    this.#activationSignal = null;
    this.#currentInvocationSignal = null;
    this.#result?.resolve(this.outcome);
    this.#result = null;
    this.sendEvent('failed');
  }

  private completeWithCancellation(error: Error): void {
    this.outcome = null;
    this.onTurnSettled();
    this.#activationSignal = null;
    this.#currentInvocationSignal = null;
    this.#result?.reject(error);
    this.#result = null;
    this.sendEvent('failed');
  }

  private failPendingTurnFatally(error: unknown): void {
    if (this.state() !== 'calling_provider') throw new Error(`LLMActor '${this.agentId}' cannot fatally settle a turn from '${this.state()}'.`);
    if (!this.#result) throw new Error(`LLMActor '${this.agentId}' has no armed turn to fatally settle.`);
    const fatal = error instanceof Error ? error : new Error(String(error));
    const pending = this.#result;
    this.onTurnSettled();
    this.#result = null;
    this.#currentInvocationSignal = null;
    this.#activationSignal = null;
    this.sendEvent('failed');
    pending.reject(fatal);
    console.error(`LLMActor '${this.agentId}' fatal handler failure`, fatal);
  }

  disposeInvocations(reason: unknown): void {
    this.#invocations.revoke(reason);
    this.#currentInvocation = null;
  }

  closeInvocationAdmission(reason: unknown): void {
    this.#invocations.closeAdmission(reason);
  }

  async joinInvocationSettlement(): Promise<InvocationJoinOutcome> {
    const outcome = await this.#invocations.join();
    await this.awaitLifecycleSettlement();
    return outcome;
  }

  pendingInvocationCount(): number {
    return this.#invocations.pendingCount();
  }

  private continueAfterTool(nextInput = this.requireInput(), signal?: AbortSignal): Promise<LLMActorOutcome> {
    this.input = nextInput;
    if (signal) this.#activationSignal = signal;
    const promise = this.armTurn();
    this.parkedSendEvent('turn');
    return promise;
  }

  private startProviderTurn(input: LlmInvocationInput, options: { resetDeliveredToolCalls: boolean; signal?: AbortSignal }): Promise<LLMActorOutcome> {
    if (options.resetDeliveredToolCalls) this.deliveredToolCallIds.clear();
    this.input = input;
    this.outcome = null;
    this.#activationSignal = options.signal ?? null;
    this.onTurnStarting(input);
    const promise = this.armTurn();
    this.parkedSendEvent('turn');
    return promise;
  }

  protected armTurn(): Promise<LLMActorOutcome> {
    this.#result = deferred<LLMActorOutcome>();
    return this.#result.promise;
  }

  private requireWaitingTool(toolCallId: string): WaitingToolCall {
    if (this.state() !== 'waiting_tool' || !this.waitingToolCall) throw new Error(`LLMActor '${this.agentId}' is not waiting for a tool result.`);
    if (this.waitingToolCall.toolCallId !== toolCallId) throw new Error(`LLMActor '${this.agentId}' is waiting for '${this.waitingToolCall.toolCallId}', not '${toolCallId}'.`);
    if (this.deliveredToolCallIds.has(toolCallId)) throw new Error(`Tool call '${toolCallId}' already has a result or error.`);
    return this.waitingToolCall;
  }

  private recordToolSettled(toolCallId: string): void {
    if (this.deliveredToolCallIds.has(toolCallId)) throw new Error(`Tool call '${toolCallId}' already has a result or error.`);
    this.deliveredToolCallIds.add(toolCallId);
  }

  private appendContinuationContext(input: LlmInvocationInput, continuationInputId: string, continuationContextHook?: LLMToolContinuationContextHook): void {
    const continuation = continuationContextHook?.(continuationInputId);
    (continuation?.messages ?? []).forEach((message, index) => {
      const result = appendUserContextMessage(this.conversations, input.sessionId, continuationInputId, 'continuation_hook', index, message);
      this.conversationPublisher?.entryAppended(result);
    });
    continuation?.afterAppend?.();
  }

  private assertPersistenceOwnership(input: LlmInvocationInput): void {
    if (input.sessionId !== input.providerConversation.sourceSessionId) throw new Error(`Persisted LLM invocation '${input.inputId}' session '${input.sessionId}' does not match provider conversation source session '${input.providerConversation.sourceSessionId}'.`);
  }

  private requireInput(): LlmInvocationInput {
    if (!this.input) throw new Error(`LLMActor '${this.agentId}' has no input.`);
    return this.input;
  }

  private createInvocationSignal(runTaskSignal: AbortSignal): AbortSignal {
    return this.#activationSignal ? AbortSignal.any([runTaskSignal, this.#activationSignal]) : runTaskSignal;
  }

  private isCurrentTurnAborted(error: unknown): boolean {
    if (this.#activationSignal?.aborted === true) return true;
    const signal = this.#currentInvocationSignal;
    if (!signal?.aborted) return false;
    if (error === signal.reason) return true;
    return error instanceof Error && error.name === 'AbortError';
  }

  private runtimeStopReason(): Error | null {
    const activationReason = this.#activationSignal?.reason;
    if (this.#activationSignal?.aborted && isRuntimeStoppedInterruption(activationReason)) return activationReason;
    const invocationReason = this.#currentInvocationSignal?.reason;
    return this.#currentInvocationSignal?.aborted && isRuntimeStoppedInterruption(invocationReason) ? invocationReason : null;
  }

  protected onTurnStarting(_input: LlmInvocationInput): void {}

  protected onTurnStateUpdated(_params: TurnStateUpdate): void {}

  protected onTurnSettled(): void {}

  protected async onBeforeProviderCall(input: LlmInvocationInput, signal: AbortSignal): Promise<LlmInvocationInput | void> {
    if (!input.preparedCompaction) throw new Error(`LLMActor '${this.agentId}' admitted an invocation without prepared compaction.`);
    if (this.state() !== 'calling_provider') throw new Error(`LLMActor '${this.agentId}' cannot compact from state '${this.state()}'.`);
    if (!this.compactor.shouldCompact(input)) return;
    const compacted = await this.compactor.compact({ strategy: 'preventive', conversations: this.conversations, input, summarizerProvider: this.summarizerProvider, signal });
    signal.throwIfAborted();
    if (compacted.kind !== 'compacted') throw new Error('Preventive compaction returned no_smaller_projection.');
    if (compacted.providerConversation.sourceSessionId !== input.providerConversation.sourceSessionId) throw new Error(`Compaction changed provider conversation source session from '${input.providerConversation.sourceSessionId}' to '${compacted.providerConversation.sourceSessionId}'.`);
    return { ...input, providerConversation: compacted.providerConversation };
  }

  protected async callProvider(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion> {
    let firstFailure: AuthoritativeContextFailure;
    try {
      return await this.provider.completeTurn(input, signal);
    } catch (error) {
      if (!isAuthoritativeContextFailure(error)) throw error;
      firstFailure = error;
    }

    this.assertProviderReplayBoundary();
    const firstAttempts = strictContextFailureAttempts(firstFailure, input.inputId);
    if (!input.preparedCompaction) throw new PostRejectionFatalError(new Error(`Context recovery for '${input.inputId}' requires prepared compaction.`));
    signal.throwIfAborted();

    let compaction: Extract<CompactionResult, { kind: 'compacted' }>;
    try {
      const result = await this.compactor.compact({ strategy: 'authoritative_context_recovery', conversations: this.conversations, input, summarizerProvider: this.summarizerProvider, signal });
      signal.throwIfAborted();
      if (result.kind === 'no_smaller_projection') {
        throw normalContextFailure(
          'Provider input context exhausted; last-chance compaction found no strictly smaller safe provider projection, so no provider retry was attempted.',
          firstAttempts,
          firstFailure.originalFailure,
        );
      }
      compaction = result;
    } catch (error) {
      if (error instanceof ProviderTurnFailure) throw error;
      if (error instanceof CompactionSummaryConstructionError) {
        signal.throwIfAborted();
        const message = `Provider input context exhausted; last-chance compaction failed while constructing a smaller projection: ${sanitizeRecoveryMessage(error.cause)}. No provider retry was attempted.`;
        throw normalContextFailure(message, firstAttempts, firstFailure.originalFailure, error.cause);
      }
      if (error instanceof CompactionAppendError) throw new PostRejectionFatalError(error.cause);
      if (error instanceof SummarizerExchangeProjectionError) throw new PostRejectionFatalError(error);
      if (signal.aborted) signal.throwIfAborted();
      throw new PostRejectionFatalError(error);
    }

    if (compaction.providerConversation.sourceSessionId !== input.providerConversation.sourceSessionId) {
      throw new PostRejectionFatalError(new Error(`Compaction changed provider conversation source session from '${input.providerConversation.sourceSessionId}' to '${compaction.providerConversation.sourceSessionId}'.`));
    }
    const retryInput = { ...input, providerConversation: compaction.providerConversation };
    let secondCompletion: ProviderTurnCompletion;
    try {
      secondCompletion = await this.provider.completeTurn(retryInput, signal);
    } catch (error) {
      if (!(error instanceof ProviderTurnFailure)) throw error;
      if (isAuthoritativeContextFailure(error)) {
        const secondAttempts = strictContextFailureAttempts(error, input.inputId);
        const combined = combineProviderAttempts(input.inputId, firstAttempts, secondAttempts);
        throw normalContextFailure(
          `Provider input context remained exhausted after one forced compacted retry (first_pass_attempts=${firstAttempts.length}, second_pass_attempts=${secondAttempts.length}, compacted_estimated_message_tokens=${compaction.estimatedProviderMessageTokens}).`,
          combined,
          error.originalFailure,
        );
      }
      throw new ProviderTurnFailure({
        failure_phase: 'provider_attempt',
        provider_exchanges: combineProviderAttempts(input.inputId, firstAttempts, error.provider_exchanges),
        originalFailure: error.originalFailure,
        message: error.message,
      });
    }
    return {
      ...secondCompletion,
      provider_exchanges: combineProviderAttempts(input.inputId, firstAttempts, secondCompletion.provider_exchanges),
    };
  }

  protected assertProviderReplayBoundary(): void {
    if (!this.#providerBoundaryEntered) throw new Error(`LLMActor '${this.agentId}' cannot recover before entering the provider boundary.`);
    if (this.#completionPersistenceEntered) throw new Error(`LLMActor '${this.agentId}' cannot recover after completion persistence began.`);
  }

  protected override _on_state_changed(oldState: string | undefined, _newState: string): void {
    if (oldState !== undefined) this.runtimeProjectionChanged?.();
  }

}

class PostRejectionFatalError extends Error {
  constructor(readonly fatalCause: unknown) {
    super('Fatal failure during post-rejection context recovery.', { cause: fatalCause });
    this.name = 'PostRejectionFatalError';
  }
}

type AuthoritativeContextFailure = ProviderTurnFailure & {
  originalFailure: LlmRequestError & { failure: Extract<LlmTransportFailure, { kind: 'input_context_exhausted' }> };
};

function isAuthoritativeContextFailure(error: unknown): error is AuthoritativeContextFailure {
  return error instanceof ProviderTurnFailure
    && error.originalFailure instanceof LlmRequestError
    && error.originalFailure.failure.kind === 'input_context_exhausted';
}

function strictContextFailureAttempts(error: ProviderTurnFailure, inputId: string): ProviderExchangeAttempt[] {
  if (error.failure_phase !== 'provider_attempt') throw new PostRejectionFatalError(new Error(`Context failure for '${inputId}' did not occur during a provider attempt.`));
  if (error.provider_exchanges.length === 0) throw new PostRejectionFatalError(new Error(`Context failure for '${inputId}' carried no provider_exchange envelope.`));
  return error.provider_exchanges.map((attempt, index) => {
    if (attempt.status !== 'error') throw new PostRejectionFatalError(new Error(`Context failure for '${inputId}' carried a non-error provider exchange.`));
    if (attempt.terminal_tool_fired !== null) throw new PostRejectionFatalError(new Error(`Context failure for '${inputId}' carried a terminal tool effect.`));
    let parsed: ReturnType<typeof providerExchangePayloadSchema.parse>;
    try {
      parsed = providerExchangePayloadSchema.parse(attempt);
    } catch (validationError) {
      throw new PostRejectionFatalError(validationError);
    }
    if (parsed.source_input_id !== inputId) throw new PostRejectionFatalError(new Error(`Context failure exchange source '${parsed.source_input_id}' does not match input '${inputId}'.`));
    if (parsed.attempt_index !== index) throw new PostRejectionFatalError(new Error(`Context failure exchange indexes for '${inputId}' are not contiguous from zero.`));
    return parsed;
  });
}

function combineProviderAttempts(inputId: string, ...passes: ProviderExchangeAttempt[][]): ProviderExchangeAttempt[] {
  return passes.flat().map((attempt, attempt_index) => ({ ...attempt, source_input_id: inputId, attempt_index }));
}

function normalContextFailure(message: string, attempts: ProviderExchangeAttempt[], classifiedFailure: LlmRequestError, cause?: unknown): ProviderTurnFailure {
  if (classifiedFailure.failure.kind !== 'input_context_exhausted') throw new Error('Normal context failure requires input_context_exhausted classification.');
  const originalFailure = new LlmRequestError({ ...classifiedFailure.failure, message });
  if (cause !== undefined) originalFailure.cause = cause;
  return new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: attempts, originalFailure });
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

import { randomUUID } from 'node:crypto';
