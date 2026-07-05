import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import type { LlmCompleteResult } from '../../agents/llm-contracts.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { actorKindFromId, parseLlmActorId } from './ids.js';
import { saveActorSnapshot } from './snapshots.js';
import { appendLlmTurnError, appendLlmTurnFinished, appendLlmTurnStarted, appendModelRepairMessage, appendToolDelivery, readLoggedToolCall, toolCallAgentMessage, toolResultAgentMessage } from './llm-delivery-log.js';
import type { LlmActiveReconstructionRecord } from './active-reconstruction.js';
import type { ToolResult } from '../../tools/invocation.js';
import { RuntimeGate } from '../runtime-gate.js';
import { deferred, type Deferred } from './deferred.js';

export type LLMActorOutcome =
  | { type: 'result'; agentId: string; result: Extract<LlmCompleteResult, { kind: 'message' }> }
  | { type: 'tool_call'; agentId: string; inputId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: 'error'; agentId: string; error: string };

export interface LLMProviderPort {
  completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<LlmCompleteResult>;
}

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

export type LLMToolContinuationContextHook = (deliveryInputId: string) => unknown[] | undefined;

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
  #toolDeliveryCounter = 0;
  #systemPromptLoggedSessionIds = new Set<string>();

  constructor(args: { projectRoot: string; agentId: string; provider: LLMProviderPort; gate?: RuntimeGate }) {
    super();
    if (actorKindFromId(args.agentId) !== 'llm') throw new Error(`LLMActor requires an LLM actor id: ${args.agentId}`);
    this.projectRoot = args.projectRoot;
    this.agentId = args.agentId;
    this.provider = args.provider;
    this.gate = args.gate ?? new RuntimeGate();
  }

  seedSystemPromptLogged(sessionId: string): void {
    this.#systemPromptLoggedSessionIds.add(sessionId);
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
    let waiting: WaitingToolCall;
    try {
      waiting = this.requireWaitingTool(toolCallId);
    } catch (error) {
      return Promise.reject(error);
    }
    this.recordToolSettled(toolCallId);
    const input = this.requireInput();
    const deliveryInputId = this.nextDeliveryInputId(input.inputId);
    const delivery = appendToolDelivery(this.projectRoot, {
      agent_id: this.agentId,
      session_id: input.sessionId,
      source_input_id: waiting.sourceInputId,
      delivery_input_id: deliveryInputId,
      tool_call_id: toolCallId,
      tool_name: waiting.toolName,
      result,
    });
    const contextMessages = this.continuationContextMessages(input, waiting, delivery, continuationContextHook);
    this.input = {
      ...input,
      inputId: deliveryInputId,
      contextMessages,
      episodeContext: { ...input.episodeContext, lastToolResult: { toolCallId, toolName: waiting.toolName, result } },
    };
    this.waitingToolCall = null;
    this.onTurnStateUpdated({ input: this.input, deliveryInputId, waitingToolCall: null });
    return this.continueAfterTool(undefined, signal);
  }

  continueAfterPlainText(repairDirective: string, signal?: AbortSignal): Promise<LLMActorOutcome> {
    if (this.state() !== 'idle') return Promise.reject(new Error(`LLMActor '${this.agentId}' cannot continue a plain-text result from '${this.state()}'.`));
    if (this.#result) return Promise.reject(new Error(`LLMActor '${this.agentId}' already has a pending turn.`));
    if (this.outcome?.type !== 'result') return Promise.reject(new Error(`LLMActor '${this.agentId}' has no plain-text result to continue.`));
    const input = this.requireInput();
    const repairInputId = this.nextDeliveryInputId(input.inputId);
    const repairMessage = appendModelRepairMessage(this.projectRoot, { ...input, inputId: repairInputId }, repairDirective);
    const repairContextMessage = { role: 'user', content: repairDirective };
    return this.startProviderTurn({
      ...input,
      inputId: repairInputId,
      contextMessages: [...input.contextMessages, repairContextMessage],
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
    this.onTurnSettled();
    this.deliveredToolCallIds.clear();
    this.#toolDeliveryCounter = 0;
    this.parkedSendEvent('abandon');
  }

  _on_enter__calling_provider(): void {
    try {
      const input = this.requireInput();
      const includeSystemPrompt = !this.#systemPromptLoggedSessionIds.has(input.sessionId);
      appendLlmTurnStarted(this.projectRoot, input, { includeSystemPrompt });
      if (includeSystemPrompt) this.#systemPromptLoggedSessionIds.add(input.sessionId);
      this.runTask(async (signal) => {
        await this.gate.waitUntilOpen();
        return this.provider.completeTurn(input, this.providerSignal(signal));
      }, {
        on_done: (result) => {
          try {
            appendLlmTurnFinished(this.projectRoot, input, result);
            this.completeWithProviderResult(input, result);
          } catch (error) {
            this.failPendingTurnFatally(error);
            throw error;
          }
        },
        on_failed: (error) => {
          try {
            if (this.isCurrentTurnAborted(error)) {
              this.completeWithCancellation(error);
              return;
            }
            this.completeWithError(input, error instanceof Error ? error.message : String(error));
          } catch (fatal) {
            this.failPendingTurnFatally(fatal);
            throw fatal;
          }
        },
      });
    } catch (error) {
      this.failPendingTurnFatally(error);
      throw error;
    }
  }

  private completeWithProviderResult(input: LlmInvocationInput, result: LlmCompleteResult): void {
    if (result.kind === 'message') {
      this.input = { ...input, contextMessages: [...input.contextMessages, { role: 'assistant', content: result.content }] };
      this.outcome = { type: 'result', agentId: this.agentId, result };
      this.onTurnSettled();
      this.#activationSignal = null;
      this.#result?.resolve(this.outcome);
      this.#result = null;
      this.sendEvent('done');
      return;
    }
    if (result.tool_calls.length !== 1) {
      this.completeWithError(input, `Provider returned ${result.tool_calls.length} parallel tool calls; only one is supported.`);
      return;
    }
    const [call] = result.tool_calls;
    this.waitingToolCall = { sourceInputId: input.inputId, toolCallId: call.id, toolName: call.function.name, toolCallArguments: call.function.arguments };
    this.onTurnStateUpdated({ input, waitingToolCall: this.waitingToolCall });
    this.outcome = { type: 'tool_call', agentId: this.agentId, inputId: input.inputId, toolCallId: call.id, toolName: call.function.name, args: parseToolArguments(call.function.arguments) };
    this.#result?.resolve(this.outcome);
    this.#result = null;
    this.sendEvent('tool_call');
  }

  private completeWithError(input: LlmInvocationInput, error: string): void {
    appendLlmTurnError(this.projectRoot, input, error);
    this.outcome = { type: 'error', agentId: this.agentId, error };
    this.onTurnSettled();
    this.#activationSignal = null;
    this.#result?.resolve(this.outcome);
    this.#result = null;
    this.sendEvent('failed');
  }

  private completeWithCancellation(error: Error): void {
    this.outcome = null;
    this.onTurnSettled();
    this.#activationSignal = null;
    this.#result?.reject(error);
    this.#result = null;
    this.sendEvent('failed');
  }

  private failPendingTurnFatally(error: unknown): void {
    const fatal = error instanceof Error ? error : new Error(String(error));
    const pending = this.#result;
    this.#result = null;
    if (pending) pending.reject(fatal);
    console.error(`LLMActor '${this.agentId}' fatal handler failure`, fatal);
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

  private continuationContextMessages(input: LlmInvocationInput, waiting: WaitingToolCall, delivery: ReturnType<typeof appendToolDelivery>, continuationContextHook?: LLMToolContinuationContextHook): unknown[] {
    const toolCallMessage = toolCallAgentMessage(input, {
      id: waiting.toolCallId,
      type: 'function',
      function: { name: waiting.toolName, arguments: waiting.toolCallArguments },
    });
    const extraMessages = continuationContextHook?.(delivery.delivery_input_id) ?? [];
    return [...input.contextMessages, toolCallMessage, toolResultAgentMessage(delivery), ...extraMessages];
  }

  private requireInput(): LlmInvocationInput {
    if (!this.input) throw new Error(`LLMActor '${this.agentId}' has no input.`);
    return this.input;
  }

  private providerSignal(runTaskSignal: AbortSignal): AbortSignal {
    return this.#activationSignal ? AbortSignal.any([runTaskSignal, this.#activationSignal]) : runTaskSignal;
  }

  private isCurrentTurnAborted(error: unknown): boolean {
    return this.#activationSignal?.aborted === true || error === this.#activationSignal?.reason;
  }

  protected onTurnStarting(_input: LlmInvocationInput): void {}

  protected onTurnStateUpdated(_params: TurnStateUpdate): void {}

  protected onTurnSettled(): void {}

  protected toolDeliveryCounter(): number {
    return this.#toolDeliveryCounter;
  }
}

export class LLMActor extends ConversationLLMActor {
  activeReconstruction: LlmActiveReconstructionRecord | null = null;

  static fromActiveReconstruction(args: { projectRoot: string; agentId: string; provider: LLMProviderPort; gate?: RuntimeGate; state: string; activeReconstruction: LlmActiveReconstructionRecord }): LLMActor {
    const actor = new LLMActor({ projectRoot: args.projectRoot, agentId: args.agentId, provider: args.provider, gate: args.gate });
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
    saveActorSnapshot(this.projectRoot, this.snapshot());
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
      },
      updated_at: new Date().toISOString(),
    };
  }

  protected override onTurnStarting(input: LlmInvocationInput): void {
    this.activeReconstruction = this.createActiveReconstruction(input);
  }

  private createActiveReconstruction(input: LlmInvocationInput): LlmActiveReconstructionRecord {
    const identity = parseLlmActorId(this.agentId);
    const cardId = identity.role === 'analyst' ? null : input.episodeContext.cardId;
    if (identity.role !== 'analyst' && (typeof cardId !== 'string' || cardId.length === 0)) throw new Error(`LLMActor '${this.agentId}' input '${input.inputId}' has no cardId reconstruction context.`);
    const reconstructionCardId = identity.role === 'analyst' ? null : cardId as string;
    return {
      schema_version: 1,
      kind: 'llm_turn',
      agent_id: this.agentId,
      role: input.role,
      card_id: reconstructionCardId,
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
