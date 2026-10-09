import type { InvocationRequest, InvocationService } from '../agents/execution-api.js';
import {
  AdmittedProviderTurnFailure,
  AdmissionIntegrityError,
  LocalExactAdmissionError,
  localAdmissionFailureReason,
  projectAdmissionDiagnostics,
} from '../contracts/index.js';
import type { LLMProviderPort, AdmittedSummaryRequest } from '../runtime/runtime-api.js';
import type { LlmInvocationInput } from '../runtime/runtime-api.js';
import type { ProviderTurnCompletion } from '../contracts/index.js';
import { materializeProviderConversation } from './conversation-image-materialization.js';

export function createInvocationServiceProvider(
  invocationService: InvocationService,
  projectRoot: string,
): LLMProviderPort {
  return {
    preparePrimaryRequestAdmission: async (input, signal) => {
      const providerConversation = await materializeProviderConversation(
        projectRoot,
        input.providerConversation,
        signal,
      );
      signal.throwIfAborted();
      return invocationService.preparePrimaryRequestAdmission(
        invocationRequest({ ...input, providerConversation }, signal),
      );
    },
    executeAdmittedWithRecovery: (admission, signal) =>
      invocationService.executeAdmittedWithRecovery(admission, signal),
    prepareAdmittedRecovery: async ({ suspension, input, signal }) => {
      const providerConversation = await materializeProviderConversation(
        projectRoot,
        input.providerConversation,
        signal,
      );
      signal.throwIfAborted();
      return invocationService.prepareAdmittedRecovery({
        suspension,
        request: invocationRequest({ ...input, providerConversation }, signal),
      });
    },
    resumeAdmittedExecution: (preparation, signal) =>
      invocationService.resumeAdmittedExecution(preparation, signal),
    preflightPinnedContentPolicyRequest: async (input, signal) => {
      const providerConversation = await materializeProviderConversation(
        projectRoot,
        input.providerConversation,
        signal,
      );
      signal.throwIfAborted();
      return invocationService.preflightPinnedContentPolicyRequest(
        invocationRequest({ ...input, providerConversation }, signal),
      );
    },
    executePinnedContentPolicyRequest: (preflight, diagnosticContext, signal) =>
      invocationService.executePinnedContentPolicyRequest(preflight, diagnosticContext, signal),
    projectProviderExchanges: (sessionId, purpose, sourceInputId, attempts, context) =>
      invocationService.projectProviderExchanges(
        sessionId,
        purpose,
        sourceInputId,
        attempts,
        context,
      ),
  };
}

export async function executeInternalSummaryTurn(
  service: InvocationService,
  input: LlmInvocationInput,
  signal: AbortSignal,
  packed: AdmittedSummaryRequest,
): Promise<ProviderTurnCompletion> {
  const admission = service.preparePrimaryRequestAdmission({
    ...invocationRequestBase(input, signal),
    modelParams: {
      temperature: input.modelParams.temperature,
      maxTokens: input.modelParams.maxTokens!,
    },
    contextUtilizationFraction: packed.contextUtilizationFraction,
  });
  if (admission.kind !== 'admitted')
    throw new LocalExactAdmissionError({
      source: 'internal_summary',
      reason: localAdmissionFailureReason(admission.candidates),
      localCompactionAttempted: false,
      diagnostics: projectAdmissionDiagnostics(admission.candidates),
    });
  const admitted = admission.candidates.filter((verdict) => verdict.kind === 'admitted');
  if (admitted.length !== 1 || admitted[0]!.plan.request.requestHash !== packed.requestSha256)
    throw new AdmissionIntegrityError(
      'Summary request bytes changed between measured admission and provider send.',
    );
  try {
    return await service.executeSummaryWithRecovery(admission, signal);
  } catch (error) {
    if (error instanceof AdmittedProviderTurnFailure) throw error.turnFailure;
    throw error;
  }
}

function invocationRequestBase(input: LlmInvocationInput, signal: AbortSignal) {
  return {
    inputId: input.inputId,
    agentName: input.agentName,
    sessionId: input.sessionId,
    systemPrompt: input.systemPrompt,
    providerConversation: input.providerConversation,
    tools: input.tools,
    terminalToolNames: input.terminalToolNames,
    capabilityRequest: input.capabilityRequest,
    abortSignal: signal,
    routePass:
      input.routePass.kind === 'ordinary'
        ? { kind: 'ordinary' as const, candidateChain: [...input.routePass.candidateChain] }
        : { kind: 'pinned-content-policy-retry' as const, candidate: input.routePass.candidate },
  };
}

function invocationRequest(input: LlmInvocationInput, signal: AbortSignal): InvocationRequest {
  const common = invocationRequestBase(input, signal);
  return input.preparedCompaction
    ? {
        ...common,
        modelParams: input.modelParams,
        preparedCompaction: input.preparedCompaction,
        preparedContext: input.preparedContext,
      }
    : { ...common, modelParams: input.modelParams };
}
