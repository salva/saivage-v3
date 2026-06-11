import { assign, createActor, createMachine } from 'xstate';
import type { OperationalAgentRole } from '../../schemas/index.js';
import type { LlmCompleteResult, ToolDefinition } from '../../agents/llm-contracts.js';
import type { CapabilityRequest } from '../../agents/provider-capabilities.js';
import { saveActorSnapshot } from './snapshots.js';
import { actorKindFromId } from './ids.js';

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

interface LlmRunnerContext {
  projectRoot: string;
  agentId: string;
  input: LlmInvocationInput | null;
  output: LlmRunnerOutput | null;
}

type LlmRunnerEvent =
  | { type: 'RUN_TURN'; input: LlmInvocationInput }
  | { type: 'PROVIDER_RESULT'; result: LlmCompleteResult }
  | { type: 'PROVIDER_ERROR'; error: string };

const llmRunnerMachine = createMachine({
  types: {} as {
    context: LlmRunnerContext;
    events: LlmRunnerEvent;
  },
  id: 'llmRunner',
  initial: 'done',
  context: ({ input }: { input: { projectRoot: string; agentId: string } }) => ({
    projectRoot: input.projectRoot,
    agentId: input.agentId,
    input: null,
    output: null,
  }),
  states: {
    done: {
      on: {
        RUN_TURN: {
          target: 'running',
          actions: assign({ input: ({ event }) => event.input, output: null }),
        },
      },
    },
    running: {
      on: {
        PROVIDER_RESULT: {
          target: 'done',
          actions: assign({
            output: ({ context, event }) => outputFromProviderResult(context.agentId, event.result),
          }),
        },
        PROVIDER_ERROR: {
          target: 'done',
          actions: assign({
            output: ({ context, event }) => ({ type: 'LLM_ERROR', agentId: context.agentId, error: event.error }),
          }),
        },
      },
    },
  },
});

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
  private readonly actor;

  constructor(projectRoot: string, readonly agentId: string, private readonly providerTurn: ProviderTurnPort) {
    if (actorKindFromId(agentId) !== 'llm') throw new Error(`LLMRunner requires an LLM actor id: ${agentId}`);
    this.actor = createActor(llmRunnerMachine, { input: { projectRoot, agentId } });
    this.actor.start();
  }

  async runTurn(input: LlmInvocationInput): Promise<LlmRunnerOutput> {
    if (input.agentId !== this.agentId) throw new Error(`Input ${input.inputId} targets ${input.agentId}, not ${this.agentId}`);
    this.actor.send({ type: 'RUN_TURN', input });
    this.persist();
    try {
      const result = await this.providerTurn.completeTurn(input);
      this.actor.send({ type: 'PROVIDER_RESULT', result });
    } catch (error) {
      this.actor.send({ type: 'PROVIDER_ERROR', error: error instanceof Error ? error.message : String(error) });
    }
    this.persist();
    const output = this.actor.getSnapshot().context.output;
    if (!output) throw new Error(`LLMRunner ${this.agentId} completed without output.`);
    return output;
  }

  get state(): 'done' | 'running' {
    return this.actor.getSnapshot().value as 'done' | 'running';
  }

  snapshot() {
    const snapshot = this.actor.getSnapshot();
    return {
      actor_id: this.agentId,
      actor_kind: 'llm' as const,
      state_value: snapshot.value,
      context: snapshot.context as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    saveActorSnapshot(this.actor.getSnapshot().context.projectRoot, this.snapshot());
  }
}
