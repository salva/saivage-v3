import { z } from 'zod';
import { agentMessageSchema } from '../../schemas/index.js';
import type { AgentMessage } from '../../schemas/index.js';
import type { InvocationRequest } from '../../agents/invocation-service.js';
import type { LlmCompleteResult } from '../../agents/llm-contracts.js';
import type { LlmInvocationInput, ProviderTurnPort } from './llm-runner.js';

export interface InvocationTurnService {
  invokeWithRecovery(request: InvocationRequest): Promise<LlmCompleteResult>;
}

const agentMessageArraySchema = z.array(agentMessageSchema);

export class InvocationProviderTurnPort implements ProviderTurnPort {
  constructor(private readonly invocationService: InvocationTurnService) {}

  async completeTurn(input: LlmInvocationInput): Promise<LlmCompleteResult> {
    return this.invocationService.invokeWithRecovery({
      role: input.role,
      sessionId: input.sessionId,
      systemPrompt: input.systemPrompt,
      contextMessages: parseContextMessages(input.contextMessages, input.inputId),
      tools: input.tools,
      terminalToolNames: input.terminalToolNames,
      modelParams: input.modelParams,
      capabilityRequest: input.capabilityRequest,
    });
  }
}

export function createInvocationProviderTurnPort(invocationService: InvocationTurnService): ProviderTurnPort {
  return new InvocationProviderTurnPort(invocationService);
}

function parseContextMessages(messages: unknown[], inputId: string): AgentMessage[] {
  const parsed = agentMessageArraySchema.safeParse(messages);
  if (!parsed.success) throw new Error(`Invalid LLM context messages for '${inputId}': ${parsed.error.message}`);
  return parsed.data;
}
