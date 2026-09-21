import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ProviderTurnFailure, type LlmCompleteResult, type ProviderTurnCompletion,
} from '../../../agents/llm-contracts.js';
import { isPromptPolicyRejection, LlmRequestError } from '../../../contracts/llm-failure.js';
import type { ProviderExchangeAttempt, ProviderExchangePublicationContext,
} from '../../../contracts/provider-exchange.js';
import { throwIfPublicationOutcomeUnknown } from '../../../contracts/index.js';
import type { ConversationSessionId } from '../../../schemas/index.js';
import type { LlmInvocationInput } from '../llm-invocation.js';
import type { Candidate } from '../../../contracts/provider-candidate.js';
import type { EffectiveProviderCapabilities } from '../../../agents/provider-capabilities.js';
import { usableInputTokens } from '../../../agents/context-budget.js';
import { COMPACTION_SUMMARY_BLOCKED_SUMMARY } from '../../../schemas/index.js';

export const SUMMARY_COMPLETION_TOKENS = 2000;
export const SUMMARY_OUTPUT_TARGET_BYTES = 12_000;
export const SUMMARY_PROMPT_POLICY_BLOCKED_MESSAGE = COMPACTION_SUMMARY_BLOCKED_SUMMARY;

const INTERNAL_SUMMARY_LABEL = 'internal-compaction-summary';

export function internalCompactionSummarySessionId(sourceSessionId: string): string {
  return `internal:compaction-summary:${createHash('sha256').update(sourceSessionId, 'utf8').digest('hex')}`;
}

export type SummaryRequestSerialization = Readonly<{
  serializedRequest: string;
  requestSha256: string;
  estimatedInputTokens: number;
}>;

export interface SummarizerProviderPort {
  readonly candidate: Candidate;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  serializeSummaryRequest(input: LlmInvocationInput): SummaryRequestSerialization;
  completeTurn(input: LlmInvocationInput, admitted: SummaryRequestSerialization, signal: AbortSignal): Promise<ProviderTurnCompletion>;
  projectProviderExchanges(sessionId: string, sourceInputId: string, attempts: ProviderExchangeAttempt[], context: ProviderExchangePublicationContext,
  ): void;
}

type SummaryRequestAdmission =
  | Readonly<{
      kind: 'admitted';
      serializedRequest: string;
      requestSha256: string;
      estimatedInputTokens: number;
      usableInputTokens: number;
    }>
  | Readonly<{ kind: 'too_large'; estimatedInputTokens: number; usableInputTokens: number }>;

export function admitSummaryRequest(args: {
  serialization: SummaryRequestSerialization;
  contextUtilizationFraction: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
}): SummaryRequestAdmission {
  if (SUMMARY_COMPLETION_TOKENS > args.maxOutputTokens)
    throw new Error(`The fixed ${SUMMARY_COMPLETION_TOKENS}-token summary completion request exceeds the candidate output limit (${args.maxOutputTokens} tokens).`);
  const inputCapacity = usableInputTokens(args.contextWindowTokens, SUMMARY_COMPLETION_TOKENS, args.contextUtilizationFraction);
  if (inputCapacity <= 0) throw new Error('The fixed summary candidate has no positive usable input capacity.');
  if (args.serialization.estimatedInputTokens > inputCapacity)
    return {
      kind: 'too_large',
      estimatedInputTokens: args.serialization.estimatedInputTokens,
      usableInputTokens: inputCapacity,
    };
  return {
    kind: 'admitted',
    serializedRequest: args.serialization.serializedRequest,
    requestSha256: args.serialization.requestSha256,
    estimatedInputTokens: args.serialization.estimatedInputTokens,
    usableInputTokens: inputCapacity,
  };
}

export type SummaryRequestItem = Readonly<{
  label: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
}>;

export function buildSummaryRequestInput(args: {
  candidate: Candidate;
  sourceSessionId: ConversationSessionId;
  instruction: string;
  items: readonly SummaryRequestItem[];
}): LlmInvocationInput {
  const messages = args.items.map((item, index) =>
    Object.freeze({
      kind: 'synthetic_context' as const,
      role: item.role,
      content: `[order ${index + 1}/${args.items.length}] ${item.label}\n${item.content}`,
      origin: 'summary_material' as const,
      block_identity: `${index + 1}:${item.label}`,
    }),
  );
  return {
    inputId: randomUUID(),
    agentId: `llm:${INTERNAL_SUMMARY_LABEL}`,
    agentName: INTERNAL_SUMMARY_LABEL,
    sessionId: internalCompactionSummarySessionId(args.sourceSessionId),
    systemPrompt: args.instruction,
    providerConversation: { sourceSessionId: args.sourceSessionId, messages },
    tools: [],
    compiledToolContracts: [],
    terminalToolNames: [],
    modelParams: { temperature: 0, maxTokens: SUMMARY_COMPLETION_TOKENS },
    capabilityRequest: { requiresTools: false },
    routePass: { kind: 'ordinary', candidateChain: [args.candidate] },
    episodeContext: { compaction: true },
  };
}

export async function invokeSummaryRequest(args: {
  input: LlmInvocationInput;
  admitted: SummaryRequestSerialization;
  summarizerProvider: SummarizerProviderPort;
  signal: AbortSignal;
}): Promise<string> {
  args.signal.throwIfAborted();
  const completion = await sendAdmittedSummaryRequest(args);
  args.signal.throwIfAborted();
  return validateSummaryCompletion(completion, args.summarizerProvider.candidate);
}

async function sendAdmittedSummaryRequest(args: {
  input: LlmInvocationInput;
  admitted: SummaryRequestSerialization;
  summarizerProvider: SummarizerProviderPort;
  signal: AbortSignal;
}): Promise<ProviderTurnCompletion> {
  try {
    const completion = await args.summarizerProvider.completeTurn(args.input, args.admitted, args.signal);
    projectSummaryExchanges(args.summarizerProvider, args.input, completion.provider_exchanges);
    return completion;
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (!(error instanceof ProviderTurnFailure)) throw error;
    projectSummaryExchanges(args.summarizerProvider, args.input, error.provider_exchanges);
    if (isPromptPolicyRejection(error.originalFailure))
      throw new SummaryPromptPolicyBlockedError(args.input.inputId, error.originalFailure);
    throw error;
  }
}

export class SummaryPromptPolicyBlockedError extends Error {
  readonly summaryInputId: string;

  constructor(summaryInputId: string, cause: unknown) {
    super(SUMMARY_PROMPT_POLICY_BLOCKED_MESSAGE, { cause });
    this.name = 'SummaryPromptPolicyBlockedError';
    this.summaryInputId = summaryInputId;
  }
}

function projectSummaryExchanges(
  provider: SummarizerProviderPort,
  input: LlmInvocationInput,
  attempts: ProviderExchangeAttempt[],
): void {
  provider.projectProviderExchanges(input.sessionId, input.inputId, attempts, {
    assistantOutputIds: [],
    terminalConversationOutputId: null,
  });
}

export class SummaryResultValidationError extends Error {
  readonly reason: 'empty_output' | 'tool_calls' | 'incomplete_output';
  readonly summaryBytes: number | null;

  constructor(reason: 'empty_output' | 'tool_calls' | 'incomplete_output', message: string, summaryBytes: number | null = null) {
    super(message);
    this.name = 'SummaryResultValidationError';
    this.reason = reason;
    this.summaryBytes = summaryBytes;
  }
}

function validateSummaryCompletion(completion: ProviderTurnCompletion, candidate: Candidate): string {
  const finalExchange = completion.provider_exchanges.at(-1);
  const finishReason = finalExchange?.status === 'ok' ? finalExchange.finish_reason : undefined;
  if (finishReason === 'length') {
    const bytes = completion.result.kind === 'message' ? Buffer.byteLength(completion.result.content.trim(), 'utf8') : null;
    throw new SummaryResultValidationError('incomplete_output', 'Summary refine output ended at the native output limit.', bytes);
  }
  if (finishReason === 'content_filter')
    throw rejectedChatCompletion(candidate, completion, 'content_policy', 'Summary provider refused the compaction request.');
  if (finishReason !== undefined && finishReason !== null) {
    const consistent = (finishReason === 'stop' && completion.result.kind === 'message') ||
      (finishReason === 'tool_calls' && completion.result.kind === 'tool_calls');
    if (!consistent)
      throw rejectedChatCompletion(candidate, completion, 'provider_protocol_error', 'Summary provider returned inconsistent completion metadata.');
  }
  return validateSummaryResult(completion.result);
}

function rejectedChatCompletion(
  candidate: Candidate,
  completion: ProviderTurnCompletion,
  kind: 'content_policy' | 'provider_protocol_error',
  message: string,
): ProviderTurnFailure {
  const status = completion.provider_exchanges.at(-1)?.response_status ?? 200;
  const originalFailure = kind === 'content_policy'
    ? new LlmRequestError({ kind, provider: candidate.provider, status, message, providerResponse: '' })
    : new LlmRequestError({ kind, provider: candidate.provider, status, message });
  return new ProviderTurnFailure({
    failure_phase: 'provider_attempt',
    provider_exchanges: completion.provider_exchanges,
    originalFailure,
    candidate,
    message,
  });
}

function validateSummaryResult(result: LlmCompleteResult): string {
  if (result.kind !== 'message')
    throw new SummaryResultValidationError('tool_calls', 'Summary refine expected prose summary text, got tool calls.');
  const text = result.content.trim();
  if (!text) throw new SummaryResultValidationError('empty_output', 'Summary refine returned an empty summary.', 0);
  return text;
}

export function assertSummarizerCapabilities(capabilities: EffectiveProviderCapabilities): asserts capabilities is EffectiveProviderCapabilities & { contextWindowTokens: number; maxOutputTokens: number } {
  if (!Number.isInteger(capabilities.contextWindowTokens) || capabilities.contextWindowTokens! <= 0)
    throw new Error('The compaction summarizer candidate must declare a positive contextWindowTokens capability.');
  if (!Number.isInteger(capabilities.maxOutputTokens) || capabilities.maxOutputTokens! <= 0)
    throw new Error('The compaction summarizer candidate must declare a positive maxOutputTokens capability.');
  if (capabilities.maxOutputTokens! < SUMMARY_COMPLETION_TOKENS)
    throw new Error(`The compaction summarizer candidate must support at least ${SUMMARY_COMPLETION_TOKENS} output tokens.`);
}
