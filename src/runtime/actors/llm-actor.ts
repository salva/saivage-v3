import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import { ProviderTurnFailure, type LlmCompleteResult, type ProviderTurnCompletion } from '../../agents/llm-contracts.js';
import type { AgentMessage } from '../../schemas/index.js';
import { genericContextMessagesForInvocation, type LlmInvocationInput } from './llm-invocation.js';
import { actorKindFromId, parseLlmActorId } from './ids.js';
import type { ActorSnapshotStore } from './snapshots.js';
import { appendLlmTurnError, appendLlmTurnMessageBatch, appendLlmTurnStarted, appendLlmTurnToolCallBatch, appendModelRepairMessage, appendToolDelivery, readLoggedToolCall, toolCallAgentMessage, toolResultAgentMessage } from './llm-delivery-log.js';
import { appendUserContextMessage, hasIndexedConversationMessageOfKind, readActiveVersionMessages, conversationMessagesForModel, type ProviderVisibleUserContextMessage } from './conversation-store.js';
import { buildResponsesReplayProjection } from '../../agents/llm-openai-responses-mapper.js';
import type { LlmActiveReconstructionRecord } from './active-reconstruction.js';
import type { ToolResult } from '../../tools/invocation.js';
import { RuntimeGate } from '../runtime-gate.js';
import { deferred, type Deferred } from './deferred.js';
import type { BufferSizeEstimator, CompactionConfig } from './compaction/compactor.js';
import type { ConversationChangePublisher } from './conversation-publisher.js';
import type { ConversationVersionReplacement } from './conversation-inventory.js';
import type { ConversationStore } from '../../persistence/conversation-store.js';
import { InvocationLifecycle, type InvocationJoinOutcome, type InvocationLease } from './invocation-lifecycle.js';
import type { ProviderExchangeAttempt } from '../../contracts/provider-exchange.js';

export type LLMActorOutcome =
  | { type: 'result'; agentId: string; result: Extract<LlmCompleteResult, { kind: 'message' }> }
  | { type: 'tool_call'; agentId: string; inputId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: 'error'; agentId: string; error: string };

export interface LLMProviderPort {
  completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion>;
  projectProviderExchanges?(sessionId: string, sourceInputId: string, attempts: ProviderExchangeAttempt[], assistantOutputIds: string[]): void;
}

export interface CompactorPort {
  shouldCompact(input: LlmInvocationInput, config: CompactionConfig, estimator: BufferSizeEstimator): { shouldCompact: boolean };
  compact(args: { projectRoot: string; conversations: ConversationStore; sessionId: string; input: LlmInvocationInput; config: CompactionConfig; summarizerProvider: LLMProviderPort; bufferSizeEstimator: BufferSizeEstimator; signal: AbortSignal }): Promise<{ rows: unknown[]; versionReplacement: ConversationVersionReplacement }>;
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
  deliveryInputId?: string;
  waitingToolCall: WaitingToolCall | null;
};

export type LLMToolContinuationContextHook = (deliveryInputId: string) => readonly ProviderVisibleUserContextMessage[] | undefined;

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
  #toolDeliveryCounter = 0;
  #systemPromptLoggedSessionIds = new Set<string>();
  #providerBoundaryEntered = false;
  #completionPersistenceEntered = false;
  readonly #invocations = new InvocationLifecycle();
  #currentInvocation: InvocationLease | null = null;

  readonly conversationPublisher?: ConversationChangePublisher;
  readonly conversations: ConversationStore;

  constructor(args: { projectRoot: string; agentId: string; provider: LLMProviderPort; conversations: ConversationStore; gate?: RuntimeGate; conversationPublisher?: ConversationChangePublisher }) {
    super();
    if (actorKindFromId(args.agentId) !== 'llm') throw new Error(`LLMActor requires an LLM actor id: ${args.agentId}`);
    this.projectRoot = args.projectRoot;
    this.agentId = args.agentId;
    this.provider = args.provider;
    this.conversations = args.conversations;
    this.gate = args.gate ?? new RuntimeGate();
    this.conversationPublisher = args.conversationPublisher;
  }

  turn(input: LlmInvocationInput, signal?: AbortSignal): Promise<LLMActorOutcome> {
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
    const deliveryInputId = this.nextDeliveryInputId(input.inputId);
    const delivery = appendToolDelivery(this.conversations, {
      agent_id: this.agentId,
      session_id: input.sessionId,
      source_input_id: waiting.sourceInputId,
      delivery_input_id: deliveryInputId,
      tool_call_id: toolCallId,
      tool_name: waiting.toolName,
      result,
    });
    this.conversationPublisher?.entryAppended(delivery.appendResult);
    const contextMessages = this.continuationContextMessages(input, waiting, delivery, continuationContextHook);
    this.input = {
      ...input,
      inputId: deliveryInputId,
      genericContextMessages: contextMessages,
      contextMessages,
      activeConversationReplay: buildResponsesReplayProjection(input.sessionId, readActiveVersionMessages(this.projectRoot, input.sessionId)),
      episodeContext: { ...input.episodeContext, lastToolResult: { toolCallId, toolName: waiting.toolName, result } },
    };
    this.waitingToolCall = null;
    this.onTurnStateUpdated({ input: this.input, deliveryInputId, waitingToolCall: null });
    return this.continueAfterTool(undefined, signal);
  }

  settleToolResultWithoutContinuation(toolCallId: string, result: ToolResult): void {
    const waiting = this.requireWaitingTool(toolCallId);
    this.recordToolSettled(toolCallId);
    const input = this.requireInput();
    const delivery = appendToolDelivery(this.conversations, {
      agent_id: this.agentId,
      session_id: input.sessionId,
      source_input_id: waiting.sourceInputId,
      delivery_input_id: this.nextDeliveryInputId(input.inputId),
      tool_call_id: toolCallId,
      tool_name: waiting.toolName,
      result,
    });
    this.conversationPublisher?.entryAppended(delivery.appendResult);
    this.input = null;
    this.outcome = null;
    this.waitingToolCall = null;
    this.#activationSignal = null;
    this.#currentInvocationSignal = null;
    this.onTurnSettled();
    this.deliveredToolCallIds.clear();
    this.#toolDeliveryCounter = 0;
    this.parkedSendEvent('abandon');
  }

  continueAfterPlainText(repairDirective: string, signal?: AbortSignal, continuationContextHook?: LLMToolContinuationContextHook): Promise<LLMActorOutcome> {
    signal?.throwIfAborted();
    if (this.state() !== 'idle') return Promise.reject(new Error(`LLMActor '${this.agentId}' cannot continue a plain-text result from '${this.state()}'.`));
    if (this.#result) return Promise.reject(new Error(`LLMActor '${this.agentId}' already has a pending turn.`));
    if (this.outcome?.type !== 'result') return Promise.reject(new Error(`LLMActor '${this.agentId}' has no plain-text result to continue.`));
    const input = this.requireInput();
    const repairInputId = this.nextDeliveryInputId(input.inputId);
    const repairMessage = appendModelRepairMessage(this.conversations, { ...input, inputId: repairInputId }, repairDirective);
    this.conversationPublisher?.entryAppended(repairMessage.appendResult);
    const extraMessages = (continuationContextHook?.(repairInputId) ?? []).map((message, index) => {
      const result = appendUserContextMessage(this.conversations, input.sessionId, repairInputId, 'continuation_hook', index, message);
      this.conversationPublisher?.entryAppended(result);
      return result.message;
    });
    return this.startProviderTurn({
      ...input,
      inputId: repairInputId,
      genericContextMessages: [...genericContextMessagesForInvocation(input), repairMessage, ...extraMessages],
      contextMessages: [...input.contextMessages, { role: 'user', content: repairDirective }, ...extraMessages],
      activeConversationReplay: buildResponsesReplayProjection(input.sessionId, readActiveVersionMessages(this.projectRoot, input.sessionId)),
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
    this.#toolDeliveryCounter = 0;
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
          if (!this.#systemPromptLoggedSessionIds.has(input.sessionId)
            && hasIndexedConversationMessageOfKind(this.projectRoot, input.sessionId, `${this.agentId}:system-prompt`, 'system_prompt')) {
            this.#systemPromptLoggedSessionIds.add(input.sessionId);
          }
          const hookInput = await this.onBeforeProviderCall(input, exactSignal);
          this.#invocations.assertCurrent(invocation);
          const effectiveInput = hookInput ?? input;
          if (hookInput) this.input = effectiveInput;
          const includeSystemPrompt = !this.#systemPromptLoggedSessionIds.has(effectiveInput.sessionId);
          for (const result of appendLlmTurnStarted(this.conversations, effectiveInput, { includeSystemPrompt })) this.conversationPublisher?.entryAppended(result);
          if (includeSystemPrompt) this.#systemPromptLoggedSessionIds.add(effectiveInput.sessionId);
          const providerInput = this.consumeTurnMessages(effectiveInput);
          this.input = providerInput;
          this.onTurnStateUpdated({ input: providerInput, waitingToolCall: null });
          await this.gate.waitUntilOpen(exactSignal);
          this.#invocations.assertCurrent(invocation);
          this.#providerBoundaryEntered = true;
          const completion = await this.provider.completeTurn(providerInput, exactSignal);
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
              if (this.isCurrentTurnAborted(error)) {
                if (invocation) this.#invocations.cancelCurrent(invocation, error);
                this.#currentInvocation = null;
                this.completeWithCancellation(error);
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
      this.conversationPublisher?.entryAppended(persisted.appended.appendResult);
      const activeRows = readActiveVersionMessages(this.projectRoot, input.sessionId);
      this.input = { ...input, genericContextMessages: conversationMessagesForModel(activeRows), contextMessages: [...input.contextMessages, { role: 'assistant', content: result.content }], activeConversationReplay: buildResponsesReplayProjection(input.sessionId, activeRows) };
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
      this.conversationPublisher?.entryAppended(persisted.appended.appendResult);
      this.settleWithError(persisted.error);
      return;
    }
    if (result.kind !== 'tool_calls') throw new Error('Persisted provider completion kind changed before delivery.');
    const [call] = result.tool_calls;
    this.conversationPublisher?.entryAppended(persisted.appended.appendResult);
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
    this.conversationPublisher?.entryAppended(appendLlmTurnError(this.conversations, input, error).appendResult);
    this.settleWithError(error);
  }

  private completeProviderFailure(input: LlmInvocationInput, error: unknown): void {
    if (!(error instanceof ProviderTurnFailure)) throw new Error(`Provider boundary for '${input.inputId}' failed without ProviderTurnFailure metadata.`);
    if (error.failure_phase === 'provider_attempt' && error.provider_exchanges.length === 0) throw new Error(`Provider attempt for '${input.inputId}' failed without provider_exchange envelope.`);
    const message = error.originalFailure instanceof Error ? error.originalFailure.message : error.message;
    const appended = appendLlmTurnError(this.conversations, input, message);
    this.conversationPublisher?.entryAppended(appended.appendResult);
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

  protected restoreToolDeliveryCounter(value: number): void {
    this.#toolDeliveryCounter = value;
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

  private nextDeliveryInputId(inputId: string): string {
    this.#toolDeliveryCounter++;
    return `${inputId}:tool:${this.#toolDeliveryCounter}`;
  }

  private continuationContextMessages(input: LlmInvocationInput, waiting: WaitingToolCall, delivery: ReturnType<typeof appendToolDelivery>, continuationContextHook?: LLMToolContinuationContextHook): AgentMessage[] {
    const toolCallMessage = toolCallAgentMessage(input, {
      id: waiting.toolCallId,
      type: 'function',
      function: { name: waiting.toolName, arguments: waiting.toolCallArguments },
    });
    const extraMessages = (continuationContextHook?.(delivery.delivery_input_id) ?? []).map((message, index) => {
      const result = appendUserContextMessage(this.conversations, input.sessionId, delivery.delivery_input_id, 'continuation_hook', index, message);
      this.conversationPublisher?.entryAppended(result);
      return result.message;
    });
    return [...genericContextMessagesForInvocation(input), toolCallMessage, toolResultAgentMessage(delivery), ...extraMessages];
  }

  private consumeTurnMessages(input: LlmInvocationInput): LlmInvocationInput {
    if (input.turnMessages === undefined) return input;
    const { turnMessages: _consumed, ...continuationInput } = input;
    return continuationInput;
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

  protected onTurnStarting(_input: LlmInvocationInput): void {}

  protected onTurnStateUpdated(_params: TurnStateUpdate): void {}

  protected onTurnSettled(): void {}

  protected async onBeforeProviderCall(_input: LlmInvocationInput, _signal: AbortSignal): Promise<LlmInvocationInput | void> {}

  protected toolDeliveryCounter(): number {
    return this.#toolDeliveryCounter;
  }
}

export class LLMActor extends ConversationLLMActor {
  readonly snapshots: ActorSnapshotStore;
  activeReconstruction: LlmActiveReconstructionRecord | null = null;
  #compacting = false;
  readonly compactor?: CompactorPort;
  readonly compactionConfig?: CompactionConfig;
  readonly summarizerProvider?: LLMProviderPort;
  readonly bufferSizeEstimator?: BufferSizeEstimator;

  static fromActiveReconstruction(args: { projectRoot: string; agentId: string; provider: LLMProviderPort; conversations: ConversationStore; snapshots: ActorSnapshotStore; gate?: RuntimeGate; state: string; activeReconstruction: LlmActiveReconstructionRecord; compactor?: CompactorPort; compactionConfig?: CompactionConfig; summarizerProvider?: LLMProviderPort; bufferSizeEstimator?: BufferSizeEstimator; conversationPublisher?: ConversationChangePublisher }): LLMActor {
    const actor = new LLMActor({ ...args });
    actor.activeReconstruction = args.activeReconstruction;
    actor.input = args.activeReconstruction.input;
    actor.deliveredToolCallIds = new Set(args.activeReconstruction.delivered_tool_call_ids);
    actor.restoreToolDeliveryCounter(args.activeReconstruction.tool_delivery_counter);
    const waiting = args.activeReconstruction.waiting_tool_call;
    if (waiting) {
      const logged = readLoggedToolCall(args.projectRoot, args.activeReconstruction.input.sessionId, args.agentId, waiting.sourceInputId, waiting.toolCallId);
      actor.waitingToolCall = {
        sourceInputId: waiting.sourceInputId,
        toolCallId: waiting.toolCallId,
        toolName: waiting.toolName,
        toolCallArguments: JSON.stringify(logged.args),
      };
      actor.outcome = { type: 'tool_call', agentId: args.agentId, inputId: waiting.sourceInputId, toolCallId: waiting.toolCallId, toolName: waiting.toolName, args: logged.args };
    }
    if (args.state === 'calling_provider') actor.armTurn();
    actor.recover(args.state);
    return actor;
  }

  protected override _on_state_changed(_oldState: string | undefined, _newState: string): void {
    this.snapshots.save(this.snapshot());
  }

  snapshot() {
    return {
      actor_id: this.agentId,
      actor_kind: 'llm' as const,
      state_value: this.state(),
      context: {
        projectRoot: this.projectRoot,
        agentId: this.agentId,
        active_reconstruction: this.activeReconstruction,
        compacting: this.#compacting,
      },
      updated_at: new Date().toISOString(),
    };
  }

  protected override onTurnStarting(input: LlmInvocationInput): void {
    this.activeReconstruction = this.createActiveReconstruction(input);
  }

  constructor(args: { projectRoot: string; agentId: string; provider: LLMProviderPort; conversations: ConversationStore; snapshots: ActorSnapshotStore; gate?: RuntimeGate; compactor?: CompactorPort; compactionConfig?: CompactionConfig; summarizerProvider?: LLMProviderPort; bufferSizeEstimator?: BufferSizeEstimator; conversationPublisher?: ConversationChangePublisher }) {
    super(args);
    if (parseLlmActorId(args.agentId).role === 'analyst') throw new Error(`LLMActor '${args.agentId}' only supports autonomous card roles.`);
    this.compactor = args.compactor;
    this.compactionConfig = args.compactionConfig;
    this.summarizerProvider = args.summarizerProvider;
    this.bufferSizeEstimator = args.bufferSizeEstimator;
    this.snapshots = args.snapshots;
  }

  protected override async onBeforeProviderCall(input: LlmInvocationInput, signal: AbortSignal): Promise<LlmInvocationInput | void> {
    if (!this.compactor) return;
    if (!this.compactionConfig || !this.summarizerProvider || !this.bufferSizeEstimator) throw new Error(`LLMActor '${this.agentId}' has incomplete compaction wiring.`);
    if (this.state() !== 'calling_provider') throw new Error(`LLMActor '${this.agentId}' cannot compact from state '${this.state()}'.`);
    const decision = this.compactor.shouldCompact(input, this.compactionConfig, this.bufferSizeEstimator);
    if (!decision.shouldCompact) return;
    try {
      this.#compacting = true;
      this.snapshots.save(this.snapshot());
      const compacted = await this.compactor.compact({ projectRoot: this.projectRoot, conversations: this.conversations, sessionId: input.sessionId, input, config: this.compactionConfig, summarizerProvider: this.summarizerProvider, bufferSizeEstimator: this.bufferSizeEstimator, signal });
      this.conversationPublisher?.versionReplaced(compacted.versionReplacement);
      const compactedRows = compacted.rows as AgentMessage[];
      const compactedInput = { ...input, genericContextMessages: conversationMessagesForModel(compactedRows), contextMessages: conversationMessagesForModel(compactedRows), activeConversationReplay: buildResponsesReplayProjection(input.sessionId, compactedRows) } as LlmInvocationInput;
      this.#compacting = false;
      if (!this.activeReconstruction) throw new Error(`LLMActor '${this.agentId}' has no active reconstruction to refresh after compaction.`);
      this.activeReconstruction = { ...this.activeReconstruction, input: compactedInput };
      this.snapshots.save(this.snapshot());
      return compactedInput;
    } finally {
      this.#compacting = false;
    }
  }

  private createActiveReconstruction(input: LlmInvocationInput): LlmActiveReconstructionRecord {
    const cardId = input.episodeContext.cardId;
    if (typeof cardId !== 'string' || cardId.length === 0) throw new Error(`LLMActor '${this.agentId}' input '${input.inputId}' has no cardId reconstruction context.`);
    return {
      schema_version: 1,
      kind: 'llm_turn',
      agent_id: this.agentId,
      role: input.role,
      card_id: cardId,
      input_id: input.inputId,
      input,
      provider_call_id: `${this.agentId}:${input.inputId}`,
      waiting_tool_call: null,
      delivered_tool_call_ids: [...this.deliveredToolCallIds],
      tool_delivery_counter: this.toolDeliveryCounter(),
      started_at: new Date().toISOString(),
    };
  }

  protected override onTurnStateUpdated(params: TurnStateUpdate): void {
    if (!this.activeReconstruction) throw new Error(`LLMActor '${this.agentId}' has no active reconstruction record.`);
    const changes: Partial<LlmActiveReconstructionRecord> = {
      input: params.input,
      delivered_tool_call_ids: [...this.deliveredToolCallIds],
      tool_delivery_counter: this.toolDeliveryCounter(),
    };
    if (params.deliveryInputId) {
      changes.input_id = params.deliveryInputId;
      changes.provider_call_id = `${this.agentId}:${params.deliveryInputId}`;
    }
    if (params.waitingToolCall) {
      changes.waiting_tool_call = activeWaitingToolCall(params.waitingToolCall);
      changes.provider_call_id = null;
    } else {
      changes.waiting_tool_call = null;
    }
    this.activeReconstruction = { ...this.activeReconstruction, ...changes };
  }

  protected override onTurnSettled(): void {
    this.activeReconstruction = null;
  }
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function activeWaitingToolCall(waiting: WaitingToolCall): LlmActiveReconstructionRecord['waiting_tool_call'] {
  return {
    sourceInputId: waiting.sourceInputId,
    toolCallId: waiting.toolCallId,
    toolName: waiting.toolName,
  };
}
