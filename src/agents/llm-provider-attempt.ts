import { sha256Hex } from '../schemas/index.js';
import type { ProviderRegistry } from './provider.js';
import { supportsCapabilityRequest } from './provider-capabilities.js';
import {
  AdmissionIntegrityError,
  ProviderTurnFailure,
  LlmRequestError,
  throwIfPublicationOutcomeUnknown,
  type CapabilityRequest,
  type CandidateRequestPlan,
  type LlmCompleteOptions,
  type ProviderTurnCompletion,
  type ProviderAttemptDiagnosticContext,
} from '../contracts/index.js';
import { CandidateRequestPlanIntegrityError } from './candidate-request.js';
import { classifyTransportFailure } from './llm-failure-classifiers.js';
import { createProviderExchangeRecorder } from './provider-exchange-recorder.js';
import { resolveLlmTransportConfig } from './llm-transport.js';
import { consumeProviderRequest, readBodyTextBestEffort } from './llm-request-inactivity.js';
import type { FailedProviderRequestDiagnostics } from './failed-provider-request-diagnostics.js';

export async function executeLlmProviderAttempt(args: {
  projectRoot: string;
  registry: ProviderRegistry;
  plan: CandidateRequestPlan;
  options: LlmCompleteOptions;
  capabilityRequest: CapabilityRequest;
  attemptContext: ProviderAttemptDiagnosticContext;
  diagnostics?: FailedProviderRequestDiagnostics;
}): Promise<ProviderTurnCompletion> {
  const { plan, options } = args;
  options.signal?.throwIfAborted();
  const serializedBody = plan.request.serializedBody;
  const actualHash = sha256Hex(serializedBody);
  if (actualHash !== plan.request.requestHash)
    throw new CandidateRequestPlanIntegrityError(
      plan.candidate,
      plan.request.requestHash,
      actualHash,
    );
  const match = supportsCapabilityRequest(plan.capabilities, {
    ...args.capabilityRequest,
    ...(plan.request.imageCount > 0 ? { requiresImages: true } : {}),
  });
  if (!match.supported)
    throw new AdmissionIntegrityError(
      `Admitted candidate request plan for ${plan.candidate.provider}/${plan.candidate.account ?? '_implicit'}/${plan.candidate.model} no longer supports its bound capability request: ${match.reasons.join(', ')}.`,
    );
  const transport = await resolveLlmTransportConfig(
    args.projectRoot,
    args.registry,
    plan.candidate,
    plan.adapter.credentialRequirement,
    options.signal,
  );
  const wire = plan.adapter.deriveWire(plan.candidate, transport, plan.request.body, options);
  const recorder = createProviderExchangeRecorder();
  const handle = await recorder.beginExchange({
    transport: wire.transport,
    contract_id: options.contract_id,
    contractName: options.contractName,
    candidate: {
      provider: plan.candidate.provider,
      model: plan.candidate.model,
      account: plan.candidate.account ?? undefined,
    },
    requestParams: { endpoint: wire.endpoint, method: 'POST', ...wire.requestParams },
    sourceInputId: options.inputId,
  });
  let exchangeRecorded = false;
  let enteredTransport = false;
  let httpStatus: number | null = null;
  let submittedAt: string;
  const capture = (
    observation: 'transport_failure' | 'provider_refusal_finish_reason',
    failure: LlmRequestError | null,
  ) => {
    if (
      !args.diagnostics ||
      options.signal?.aborted ||
      !enteredTransport ||
      failure?.failure.kind === 'cancelled'
    )
      return;
    args.diagnostics.capture(
      {
        context: args.attemptContext,
        serializedBody,
        contractId: options.contract_id,
        protocol: plan.capabilities.transportProtocol,
        provider: plan.candidate.provider,
        model: plan.candidate.model,
        submittedAt,
        completedAt: new Date().toISOString(),
        observation,
        failureKind: failure?.failure.kind ?? 'content_filter',
        providerCode: failure?.diagnostics?.providerCode ?? null,
        providerCodeTruncated: failure?.diagnostics?.providerCodeTruncated ?? false,
        finishReason: observation === 'provider_refusal_finish_reason' ? 'content_filter' : null,
        httpStatus,
        embeddedStatus: failure?.diagnostics?.embeddedStatus ?? null,
      },
      transport.apiKey,
    );
  };
  try {
    options.signal?.throwIfAborted();
    submittedAt = new Date().toISOString();
    enteredTransport = true;
    const { response, parsed } = await consumeProviderRequest(
      wire.endpoint,
      { method: 'POST', headers: wire.headers, body: serializedBody },
      options.signal,
      async (response, consumption) => {
        httpStatus = response.status;
        if (!response.ok) {
          const bodyText = await readBodyTextBestEffort(consumption, response);
          throw plan.adapter.classifyHttpFailure(
            plan.candidate,
            response,
            bodyText,
            plan.request.body,
            options,
            plan.request.imageCount > 0,
          );
        }
        const parsed = await plan.adapter.parseSuccess(
          plan.candidate,
          response,
          options,
          consumption,
          plan.request.imageCount > 0,
        );
        return { response, parsed };
      },
    );
    exchangeRecorded = true;
    if (parsed.finishReason === 'content_filter') capture('provider_refusal_finish_reason', null);
    await handle.recordResponse(
      {
        status: response.status,
        token_usage: parsed.result.usage,
        finish_reason: parsed.finishReason,
      },
      firedTerminal(parsed.result, options.terminalToolOffered),
    );
    return {
      result: parsed.result,
      provider_exchanges: recorder.settledAttempts(),
      ...(parsed.privateContext ? { provider_private_context: parsed.privateContext } : {}),
    };
  } catch (caught) {
    throwIfPublicationOutcomeUnknown(caught);
    if (exchangeRecorded) throw caught;
    exchangeRecorded = true;
    let originalFailure: LlmRequestError;
    if (options.signal?.aborted && caught === options.signal.reason)
      originalFailure = new LlmRequestError({
        kind: 'cancelled',
        provider: plan.candidate.provider,
        reason: 'abort',
        message: caught instanceof Error && caught.message ? caught.message : 'LLM request aborted',
      });
    else if (caught instanceof LlmRequestError) originalFailure = caught;
    else
      originalFailure = new LlmRequestError(
        classifyTransportFailure(caught, {
          provider: plan.candidate.provider,
          model: plan.candidate.model,
        }),
      );
    capture('transport_failure', originalFailure);
    const evidence = rawErrorEvidence(caught);
    await handle.recordError({ ...evidence, status: llmRequestStatus(caught) });
    throw new ProviderTurnFailure({
      failure_phase: 'provider_attempt',
      provider_exchanges: recorder.settledAttempts(),
      originalFailure,
      candidate: plan.candidate,
    });
  }
}

function rawErrorEvidence(caught: unknown): { errorName: string; message: string } {
  if (caught instanceof Error)
    return { errorName: caught.name || 'Error', message: caught.message };
  return { errorName: 'Error', message: String(caught) };
}

function llmRequestStatus(caught: unknown): number | undefined {
  if (!(caught instanceof LlmRequestError) || !('status' in caught.failure)) return undefined;
  return (caught.failure as { status?: number }).status;
}

function firedTerminal(
  result: ProviderTurnCompletion['result'],
  offeredNames: readonly string[],
): string | null {
  if (result.kind !== 'tool_calls') return null;
  const offered = new Set(offeredNames);
  for (const call of result.tool_calls) {
    if (offered.has(call.function.name)) return call.function.name;
  }
  return null;
}
