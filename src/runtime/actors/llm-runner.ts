import type { OperationalAgentRole } from '../../schemas/index.js';
import type { LlmCompleteResult, ToolDefinition } from '../../agents/llm-contracts.js';
import type { CapabilityRequest } from '../../agents/provider-capabilities.js';
import { BaseActor, dispatchCall, dispatchEvent, startActor } from '../fsm/index.js';
import { saveActorSnapshot } from './snapshots.js';
import { actorKindFromId } from './ids.js';
import { appendLlmTurnError, appendLlmTurnFinished, appendLlmTurnStarted } from './llm-delivery-log.js';

export interface LlmInvocationInput {
  inputId: string;
  agentId: string;
  role: OperationalAgentRole;
  sessionId: string;
  systemPrompt: string;
  contextMessages: unknown[];
  tools: ToolDefinition[];
  terminalToolNames: string[];
  modelParams: { temperature?: number; maxTokens?: number };
  capabilityRequest: CapabilityRequest;
  episodeContext: Record<string, unknown>;
}

export type LlmRunnerOutput =
  | { type: 'LLM_RESULT'; agentId: string; result: Extract<LlmCompleteResult, { kind: 'message' }> }
  | { type: 'LLM_TOOL_CALL'; agentId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: 'LLM_ERROR'; agentId: string; error: string };

export interface ProviderTurnPort {
  completeTurn(input: LlmInvocationInput): Promise<LlmCompleteResult>;
}

export interface AdmissionPort {
  requestProviderCall(callId: string): boolean;
  releaseProviderCall(callId: string): void;
}

export interface LlmRunnerContext {
  projectRoot: string;
  agentId: string;
  input: LlmInvocationInput | null;
  output: LlmRunnerOutput | null;
}

type ProviderResultArgs = { result: LlmCompleteResult };
type ProviderErrorArgs = { error: string };

export class LlmRunnerActor extends BaseActor {
  static _actor = {
    initial: 'done',
    states: {
      done: {
        on: { run: 'running' },
        calls: { run: 'recordRun' },
      },
      running: {
        on: { done: 'done', failed: 'done' },
        calls: { provider_result: 'recordProviderResult', provider_error: 'recordProviderError' },
      },
    },
  };

  input: LlmInvocationInput | null = null;
  output: LlmRunnerOutput | null = null;

  constructor(readonly projectRoot: string, readonly agentId: string) {
    super();
  }

  recordRun(input: LlmInvocationInput): void {
    this.input = input;
    this.output = null;
  }

  recordProviderResult(args: ProviderResultArgs): void {
    this.output = outputFromProviderResult(this.agentId, args.result);
  }

  recordProviderError(args: ProviderErrorArgs): void {
    this.output = { type: 'LLM_ERROR', agentId: this.agentId, error: args.error };
  }

  context(): LlmRunnerContext {
    return {
      projectRoot: this.projectRoot,
      agentId: this.agentId,
      input: this.input,
      output: this.output,
    };
  }
}

function outputFromProviderResult(agentId: string, result: LlmCompleteResult): LlmRunnerOutput {
  if (result.kind === 'message') return { type: 'LLM_RESULT', agentId, result };
  const [call] = result.tool_calls;
  if (!call) return { type: 'LLM_ERROR', agentId, error: 'Provider returned tool_calls without a tool call.' };
  return {
    type: 'LLM_TOOL_CALL',
    agentId,
    toolCallId: call.id,
    toolName: call.function.name,
    args: parseToolArguments(call.function.arguments),
  };
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export class LlmRunnerController {
  private readonly actor: LlmRunnerActor;

  constructor(
    projectRoot: string,
    readonly agentId: string,
    private readonly providerTurn: ProviderTurnPort,
    private readonly admission?: AdmissionPort,
  ) {
    if (actorKindFromId(agentId) !== 'llm') throw new Error(`LLMRunner requires an LLM actor id: ${agentId}`);
    this.actor = startActor(LlmRunnerActor, projectRoot, agentId);
  }

  async runTurn(input: LlmInvocationInput): Promise<LlmRunnerOutput> {
    if (input.agentId !== this.agentId) throw new Error(`Input ${input.inputId} targets ${input.agentId}, not ${this.agentId}`);
    dispatchCall(this.actor, { kind: 'call', name: 'run', args: input });
    dispatchEvent(this.actor, { kind: 'event', name: 'run' });
    this.persist();
    appendLlmTurnStarted(this.actor.projectRoot, input);
    const callId = `${this.agentId}:${input.inputId}`;
    if (this.admission && !this.admission.requestProviderCall(callId)) {
      const error = `Provider admission denied for ${callId}.`;
      appendLlmTurnError(this.actor.projectRoot, input, error);
      dispatchCall(this.actor, { kind: 'call', name: 'provider_error', args: { error } });
      dispatchEvent(this.actor, { kind: 'event', name: 'failed' });
      this.persist();
      const output = this.actor.output;
      if (!output) throw new Error(`LLMRunner ${this.agentId} completed without output.`);
      return output;
    }
    try {
      const result = await this.providerTurn.completeTurn(input);
      appendLlmTurnFinished(this.actor.projectRoot, input, result);
      dispatchCall(this.actor, { kind: 'call', name: 'provider_result', args: { result } });
      dispatchEvent(this.actor, { kind: 'event', name: 'done' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLlmTurnError(this.actor.projectRoot, input, message);
      dispatchCall(this.actor, { kind: 'call', name: 'provider_error', args: { error: message } });
      dispatchEvent(this.actor, { kind: 'event', name: 'failed' });
    } finally {
      this.admission?.releaseProviderCall(callId);
    }
    this.persist();
    const output = this.actor.output;
    if (!output) throw new Error(`LLMRunner ${this.agentId} completed without output.`);
    return output;
  }

  get state(): 'done' | 'running' {
    return this.actor.state() as 'done' | 'running';
  }

  snapshot() {
    return {
      actor_id: this.agentId,
      actor_kind: 'llm' as const,
      state_value: this.actor.state(),
      context: this.actor.context() as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    saveActorSnapshot(this.actor.projectRoot, this.snapshot());
  }
}
