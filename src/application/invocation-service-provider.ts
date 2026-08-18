import type { InvocationRequest, InvocationService } from '../agents/invocation-service.js';
import {
  AdmittedProviderTurnFailure,
  AdmissionIntegrityError,
  LocalExactAdmissionError,
  projectAdmissionDiagnostics,
} from '../agents/invocation-admission.js';
import type { LLMProviderPort } from '../runtime/actors/index.js';
import type { LlmInvocationInput } from '../runtime/actors/llm-invocation.js';
import type { ProviderTurnCompletion } from '../agents/llm-contracts.js';

export function createInvocationServiceProvider(invocationService: InvocationService): LLMProviderPort {
  return {
    preparePrimaryRequestAdmission: (input, signal) => invocationService.preparePrimaryRequestAdmission(invocationRequest(input, signal)),
    executeAdmittedWithRecovery: (admission, signal) => invocationService.executeAdmittedWithRecovery(admission, signal),
    prepareAdmittedRecovery: ({ suspension, input, signal }) =>
      invocationService.prepareAdmittedRecovery({ suspension, request: invocationRequest(input, signal) }),
    resumeAdmittedExecution: (preparation, signal) => invocationService.resumeAdmittedExecution(preparation, signal),
    preflightPinnedContentPolicyRequest: (input, signal) => invocationService.preflightPinnedContentPolicyRequest(invocationRequest(input, signal)),
    executePinnedContentPolicyRequest: (preflight, signal) => invocationService.executePinnedContentPolicyRequest(preflight, signal),
    projectProviderExchanges: (sessionId, sourceInputId, attempts, context) => invocationService.projectProviderExchanges(sessionId, sourceInputId, attempts, context),
  };
}

export async function executeAdmittedTurn(service: InvocationService, input: LlmInvocationInput, signal: AbortSignal, expectedRequestSha256?: string): Promise<ProviderTurnCompletion> {
  const admission = service.preparePrimaryRequestAdmission(invocationRequest(input, signal));
  if (admission.kind !== 'admitted')
    throw new LocalExactAdmissionError({ localCompactionAttempted: false, diagnostics: projectAdmissionDiagnostics(admission.candidates) });
  if (expectedRequestSha256 !== undefined) {
    const admitted = admission.candidates.filter((verdict) => verdict.kind === 'admitted');
    if (admitted.length !== 1 || admitted[0]!.plan.request.requestHash !== expectedRequestSha256)
      throw new AdmissionIntegrityError('Summary request bytes changed between measured admission and provider send.');
  }
  try {
    return await service.executeAdmittedWithRecovery(admission, signal);
  } catch (error) {
    if (error instanceof AdmittedProviderTurnFailure) throw error.turnFailure;
    throw error;
  }
}

export function invocationRequest(input: LlmInvocationInput, signal: AbortSignal): InvocationRequest {
  const common = {
    inputId: input.inputId, agentName: input.agentName, sessionId: input.sessionId, systemPrompt: input.systemPrompt,
    providerConversation: input.providerConversation,
    tools: input.tools, terminalToolNames: input.terminalToolNames, capabilityRequest: input.capabilityRequest, abortSignal: signal,
    routePass: input.routePass.kind === 'ordinary' ? { kind: 'ordinary' as const, candidateChain: [...input.routePass.candidateChain] } : { kind: 'pinned-content-policy-retry' as const, candidate: input.routePass.candidate },
  };
  return input.preparedCompaction
    ? { ...common, modelParams: input.modelParams, preparedCompaction: input.preparedCompaction, preparedContext: input.preparedContext }
    : { ...common, modelParams: input.modelParams };
}
