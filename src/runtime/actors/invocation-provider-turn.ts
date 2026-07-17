import type { InvocationRequest } from '../../agents/invocation-service.js';
import type { ProviderTurnCompletion } from '../../agents/llm-contracts.js';
import type { LlmInvocationInput, ProviderTurnPort } from './llm-invocation.js';

export interface InvocationTurnService {
  invokeWithRecovery(request: InvocationRequest): Promise<ProviderTurnCompletion>;
}

export class InvocationProviderTurnPort implements ProviderTurnPort {
  constructor(private readonly invocationService: InvocationTurnService) {}

  async completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion> {
    const common = {
      inputId: input.inputId,
      role: input.role,
      sessionId: input.sessionId,
      systemPrompt: input.systemPrompt,
      providerConversation: input.providerConversation,
      tools: input.tools,
      terminalToolNames: input.terminalToolNames,
      capabilityRequest: input.capabilityRequest,
      abortSignal: signal,
    };
    return this.invocationService.invokeWithRecovery(input.preparedCompaction
      ? { ...common, modelParams: input.modelParams, preparedCompaction: input.preparedCompaction }
      : { ...common, modelParams: input.modelParams });
  }
}

export function createInvocationProviderTurnPort(invocationService: InvocationTurnService): ProviderTurnPort {
  return new InvocationProviderTurnPort(invocationService);
}
