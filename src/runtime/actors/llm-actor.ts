import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import type { LlmCompleteResult } from '../../agents/llm-contracts.js';
import type { LlmInvocationInput } from './llm-runner.js';
import { actorKindFromId } from './ids.js';
import { saveActorSnapshot } from './snapshots.js';
import { appendLlmTurnError, appendLlmTurnFinished, appendLlmTurnStarted, appendToolCallStatus, appendToolDelivery } from './llm-delivery-log.js';

export type LLMActorOutcome =
  | { type: 'result'; agentId: string; result: Extract<LlmCompleteResult, { kind: 'message' }> }
  | { type: 'tool_call'; agentId: string; inputId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: 'error'; agentId: string; error: string };

export interface LLMProviderPort {
  completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<LlmCompleteResult>;
}

export interface LLMAdmissionPort {
  requestProviderCall(callId: string): boolean;
  releaseProviderCall(callId: string): void;
}

type PendingTurn = {
  resolve: (outcome: LLMActorOutcome) => void;
  reject: (error: Error) => void;
};

type WaitingToolCall = {
  sourceInputId: string;
  toolCallId: string;
  toolName: string;
};

export class LLMActor extends BaseActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { turn: 'calling_provider', cancel: 'cancelled' } },
      calling_provider: { on: { done: 'idle', failed: 'idle', tool_call: 'waiting_tool', cancel: 'cancelled' } },
      waiting_tool: { parked: true, on: { turn: 'calling_provider', failed: 'idle', cancel: 'cancelled' } },
      cancelled: { terminal: true },
    },
  };

  readonly projectRoot: string;
  readonly agentId: string;
  readonly provider: LLMProviderPort;
  readonly admission?: LLMAdmissionPort;
  input: LlmInvocationInput | null = null;
  outcome: LLMActorOutcome | null = null;
  waitingToolCall: WaitingToolCall | null = null;
  deliveredToolCallIds = new Set<string>();
  #pendingTurn: PendingTurn | null = null;
  #toolDeliveryCounter = 0;

  constructor(args: { projectRoot: string; agentId: string; provider: LLMProviderPort; admission?: LLMAdmissionPort }) {
    super();
    if (actorKindFromId(args.agentId) !== 'llm') throw new Error(`LLMActor requires an LLM actor id: ${args.agentId}`);
    this.projectRoot = args.projectRoot;
    this.agentId = args.agentId;
    this.provider = args.provider;
    this.admission = args.admission;
  }

  turn(input: LlmInvocationInput): Promise<LLMActorOutcome> {
    if (input.agentId !== this.agentId) return Promise.reject(new Error(`Input ${input.inputId} targets ${input.agentId}, not ${this.agentId}.`));
    if (this.#pendingTurn) return Promise.reject(new Error(`LLMActor '${this.agentId}' already has a pending turn.`));
    if (this.state() !== 'idle') return Promise.reject(new Error(`LLMActor '${this.agentId}' cannot start a new turn from '${this.state()}'.`));
    this.input = input;
    this.outcome = null;
    return new Promise<LLMActorOutcome>((resolve, reject) => {
      this.#pendingTurn = { resolve, reject };
      this.parkedSendEvent('turn');
    });
  }

  appendToolResult(toolCallId: string, result: unknown): Promise<LLMActorOutcome> {
    let waiting: WaitingToolCall;
    try {
      waiting = this.requireWaitingTool(toolCallId);
    } catch (error) {
      return Promise.reject(error);
    }
    this.recordToolSettled(toolCallId);
    const input = this.requireInput();
    const deliveryInputId = this.nextDeliveryInputId(input.inputId);
    appendToolDelivery(this.projectRoot, {
      agent_id: this.agentId,
      source_input_id: waiting.sourceInputId,
      delivery_input_id: deliveryInputId,
      tool_call_id: toolCallId,
      tool_name: waiting.toolName,
      result,
    });
    this.input = {
      ...input,
      inputId: deliveryInputId,
      episodeContext: { ...input.episodeContext, lastToolResult: { toolCallId, toolName: waiting.toolName, result } },
    };
    this.waitingToolCall = null;
    return this.continueAfterTool();
  }

  appendToolError(toolCallId: string, error: string): Promise<LLMActorOutcome> {
    let waiting: WaitingToolCall;
    try {
      waiting = this.requireWaitingTool(toolCallId);
    } catch (caught) {
      return Promise.reject(caught);
    }
    this.recordToolSettled(toolCallId);
    appendToolCallStatus(this.projectRoot, {
      agent_id: this.agentId,
      source_input_id: waiting.sourceInputId,
      tool_call_id: toolCallId,
      tool_name: waiting.toolName,
      status: 'errored',
      error,
    });
    const input = this.requireInput();
    const deliveryInputId = this.nextDeliveryInputId(input.inputId);
    this.input = {
      ...input,
      inputId: deliveryInputId,
      episodeContext: { ...input.episodeContext, lastToolResult: { toolCallId, toolName: waiting.toolName, error } },
    };
    this.waitingToolCall = null;
    return this.continueAfterTool();
  }

  _on_enter__calling_provider(): void {
    const input = this.requireInput();
    appendLlmTurnStarted(this.projectRoot, input);
    const callId = `${this.agentId}:${input.inputId}`;
    if (this.admission && !this.admission.requestProviderCall(callId)) {
      this.completeWithError(input, `Provider admission denied for ${callId}.`);
      return;
    }
    this.runTask((signal) => this.provider.completeTurn(input, signal), {
      on_done: (result) => {
        try {
          appendLlmTurnFinished(this.projectRoot, input, result);
          this.completeWithProviderResult(input, result);
        } finally {
          this.admission?.releaseProviderCall(callId);
        }
      },
      on_failed: (error) => {
        try {
          this.completeWithError(input, error.message);
        } finally {
          this.admission?.releaseProviderCall(callId);
        }
      },
    });
  }

  protected override _on_state_changed(_oldState: string | undefined, _newState: string): void {
    this.persist();
  }

  snapshot() {
    return {
      actor_id: this.agentId,
      actor_kind: 'llm' as const,
      state_value: this.state(),
      context: {
        projectRoot: this.projectRoot,
        agentId: this.agentId,
        input: this.input,
        outcome: this.outcome,
        waitingToolCall: this.waitingToolCall,
        deliveredToolCallIds: [...this.deliveredToolCallIds],
      },
      updated_at: new Date().toISOString(),
    };
  }

  private completeWithProviderResult(input: LlmInvocationInput, result: LlmCompleteResult): void {
    if (result.kind === 'message') {
      this.outcome = { type: 'result', agentId: this.agentId, result };
      this.#pendingTurn?.resolve(this.outcome);
      this.#pendingTurn = null;
      this.sendEvent('done');
      return;
    }
    if (result.tool_calls.length !== 1) {
      this.completeWithError(input, `Provider returned ${result.tool_calls.length} parallel tool calls; only one is supported.`);
      return;
    }
    const [call] = result.tool_calls;
    this.waitingToolCall = { sourceInputId: input.inputId, toolCallId: call.id, toolName: call.function.name };
    this.outcome = { type: 'tool_call', agentId: this.agentId, inputId: input.inputId, toolCallId: call.id, toolName: call.function.name, args: parseToolArguments(call.function.arguments) };
    this.#pendingTurn?.resolve(this.outcome);
    this.#pendingTurn = null;
    this.sendEvent('tool_call');
  }

  private completeWithError(input: LlmInvocationInput, error: string): void {
    appendLlmTurnError(this.projectRoot, input, error);
    this.outcome = { type: 'error', agentId: this.agentId, error };
    this.#pendingTurn?.resolve(this.outcome);
    this.#pendingTurn = null;
    this.sendEvent('failed');
  }

  private continueAfterTool(): Promise<LLMActorOutcome> {
    return new Promise<LLMActorOutcome>((resolve, reject) => {
      this.#pendingTurn = { resolve, reject };
      this.parkedSendEvent('turn');
    });
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

  private requireInput(): LlmInvocationInput {
    if (!this.input) throw new Error(`LLMActor '${this.agentId}' has no input.`);
    return this.input;
  }

  private persist(): void {
    saveActorSnapshot(this.projectRoot, this.snapshot());
  }
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
