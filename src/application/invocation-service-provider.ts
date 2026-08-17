import type { InvocationRequest, InvocationService } from '../agents/invocation-service.js';
import type { LLMProviderPort } from '../runtime/actors/index.js';
import type { LlmInvocationInput } from '../runtime/actors/llm-invocation.js';

export function createInvocationServiceProvider(invocationService: InvocationService): LLMProviderPort {
  return {
    preparePrimaryRequest: (input, signal) => invocationService.preparePrimaryRequestAdmission(invocationRequest(input, signal)),
    executeAdmitted: (admission) => invocationService.executeAdmittedWithRecovery(admission),
    resumeSuspended: (suspension, input, signal) => invocationService.resumeSuspendedAfterCompaction(suspension, invocationRequest(input, signal)),
    preflightPinned: (input, signal) => {
      if (input.routePass.kind !== 'pinned-content-policy-retry') throw new Error('Pinned preflight requires pinned route authority.');
      return invocationService.preflightPinnedContentPolicyRequest(invocationRequest(input, signal), input.routePass.candidate);
    },
    executePinned: (preflight) => invocationService.executePinnedContentPolicyRequest(preflight),
    projectProviderExchanges: (sessionId, sourceInputId, attempts, context) => invocationService.projectProviderExchanges(sessionId, sourceInputId, attempts, context),
  };
}

export function invocationRequest(input: LlmInvocationInput, signal: AbortSignal): InvocationRequest {
  const common = {
    inputId: input.inputId, agentName: input.agentName, sessionId: input.sessionId, prefix: input.prefix,
    providerConversation: input.providerConversation,
    compiledTools: input.compiledTools, internalToolContractSha256: input.internalToolContractSha256,
    dynamicBlocks: input.dynamicBlocks, dynamicBlocksSha256: input.dynamicBlocksSha256,
    capabilityRequest: input.capabilityRequest, abortSignal: signal,
    routePass: input.routePass.kind === 'ordinary' ? { kind: 'ordinary' as const, candidateChain: [...input.routePass.candidateChain] } : { kind: 'pinned-content-policy-retry' as const, candidate: input.routePass.candidate },
  };
  return input.preparedCompaction
    ? { ...common, modelParams: input.modelParams, preparedCompaction: input.preparedCompaction }
    : { ...common, modelParams: input.modelParams };
}
