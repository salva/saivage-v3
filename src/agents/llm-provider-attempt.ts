import { createHash } from 'node:crypto';
import type { ProviderRegistry } from './provider.js';
import {
  capabilityRequestForLlmOptions,
  supportsCapabilityRequest,
} from './provider-capabilities.js';
import {
  CandidateRequestPlanIntegrityError,
  type CandidateRequestPlan,
} from './candidate-request.js';
import type { LlmCompleteOptions, ProviderTurnCompletion } from './llm-contracts.js';
import { ProviderTurnFailure } from './llm-contracts.js';
import { LlmRequestError } from './llm-errors.js';
import { classifyTransportFailure } from './llm-failure-classifiers.js';
import { createProviderExchangeRecorder } from './provider-exchange-recorder.js';
import { resolveLlmTransportConfig } from './llm-transport.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';

export async function executeLlmProviderAttempt(args: {
  projectRoot: string;
  registry: ProviderRegistry;
  sessionId: string;
  plan: CandidateRequestPlan;
  options: LlmCompleteOptions;
}): Promise<ProviderTurnCompletion> {
  const { plan, options } = args;
  options.signal?.throwIfAborted();
  const actualHash = createHash('sha256').update(plan.request.serializedBody, 'utf8').digest('hex');
  if (actualHash !== plan.request.requestHash)
    throw new CandidateRequestPlanIntegrityError(
      plan.candidate,
      plan.request.requestHash,
      actualHash,
    );
  const match = supportsCapabilityRequest(
    plan.capabilities,
    capabilityRequestForLlmOptions({ tools: options.tools, stream: options.stream }),
  );
  if (!match.supported)
    throw new LlmRequestError({
      kind: 'capability_mismatch',
      provider: plan.candidate.provider,
      model: plan.candidate.model,
      requested: match.reasons,
      supported: [],
      message: `Candidate ${JSON.stringify(plan.candidate)} does not support requested LLM capabilities: ${match.reasons.join(', ')}`,
    });
  const transport = await resolveLlmTransportConfig(
    args.projectRoot,
    args.registry,
    plan.candidate,
    plan.adapter.credentialRequirement,
    options.signal,
  );
  const wire = plan.adapter.deriveWire(plan.candidate, transport, plan.request.body, options);
  const recorder = createProviderExchangeRecorder({ sessionId: args.sessionId });
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
    terminalToolOffered: options.terminalToolOffered,
    sourceInputId: options.inputId,
  });
  let exchangeRecorded = false;
  try {
    const response = await fetch(wire.endpoint, {
      method: 'POST',
      headers: wire.headers,
      body: plan.request.serializedBody,
      signal: options.signal,
    });
    if (!response.ok)
      throw plan.adapter.classifyHttpFailure(
        plan.candidate,
        response,
        await response
          .clone()
          .text()
          .catch(() => ''),
        plan.request.body,
        options,
      );
    const parsed = await plan.adapter.parseSuccess(plan.candidate, response, options);
    exchangeRecorded = true;
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
    const evidence = rawErrorEvidence(caught);
    await handle.recordError({ ...evidence, status: llmRequestStatus(caught) });
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
    throw new ProviderTurnFailure({
      failure_phase: 'provider_attempt',
      provider_exchanges: recorder.settledAttempts(),
      originalFailure,
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
