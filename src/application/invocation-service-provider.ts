import type { InvocationRequest, InvocationService } from '../agents/invocation-service.js';
import type { LLMProviderPort } from '../runtime/actors/index.js';
import type { LlmInvocationInput } from '../runtime/actors/llm-invocation.js';

export function createInvocationServiceProvider(invocationService: InvocationService): LLMProviderPort {
  return {
    completeTurn: (input, signal) => invocationService.invokeWithRecovery(invocationRequest(input, signal)),
    projectProviderExchanges: (sessionId, sourceInputId, attempts, assistantOutputIds, operationError) => invocationService.projectProviderExchanges(sessionId, sourceInputId, attempts, assistantOutputIds, operationError),
  };
}

export function invocationRequest(input: LlmInvocationInput, signal: AbortSignal, candidateChain?: NonNullable<InvocationRequest['candidateChain']>): InvocationRequest {
  const boundCandidates=candidateChain??input.candidateChain;
  if(!boundCandidates)throw new Error(`LLM invocation for agent '${input.agentName}' has no bound candidate chain.`);
  const common = {
    inputId: input.inputId, agentName: input.agentName, sessionId: input.sessionId, systemPrompt: input.systemPrompt,
    providerConversation: input.providerConversation,
    tools: input.tools, terminalToolNames: input.terminalToolNames, capabilityRequest: input.capabilityRequest, abortSignal: signal,
    candidateChain: [...boundCandidates],
  };
  return input.preparedCompaction
    ? { ...common, modelParams: input.modelParams, preparedCompaction: input.preparedCompaction }
    : { ...common, modelParams: input.modelParams };
}
