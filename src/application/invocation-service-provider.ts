import type { InvocationRequest, InvocationService } from '../agents/invocation-service.js';
import type { LLMProviderPort } from '../runtime/actors/index.js';
import type { LlmInvocationInput } from '../runtime/actors/llm-invocation.js';

export function createInvocationServiceProvider(invocationService: InvocationService): LLMProviderPort {
  return {
    completeTurn: (input, signal) => invocationService.invokeWithRecovery(invocationRequest(input, signal)),
    projectProviderExchanges: (sessionId, sourceInputId, attempts, context) => invocationService.projectProviderExchanges(sessionId, sourceInputId, attempts, context),
  };
}

export function invocationRequest(input: LlmInvocationInput, signal: AbortSignal): InvocationRequest {
  const common = {
    inputId: input.inputId, agentName: input.agentName, sessionId: input.sessionId, systemPrompt: input.systemPrompt,
    providerConversation: input.providerConversation,
    tools: input.tools, terminalToolNames: input.terminalToolNames, capabilityRequest: input.capabilityRequest, abortSignal: signal,
    routePass: input.routePass.kind === 'ordinary' ? { kind: 'ordinary' as const, candidateChain: [...input.routePass.candidateChain] } : { kind: 'pinned-content-policy-retry' as const, candidate: input.routePass.candidate },
  };
  return input.preparedCompaction
    ? { ...common, modelParams: input.modelParams, preparedCompaction: input.preparedCompaction }
    : { ...common, modelParams: input.modelParams };
}
