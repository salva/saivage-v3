import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ProviderTurnFailure, type LlmCompleteResult, type ProviderTurnCompletion,
} from '../../../agents/llm-contracts.js';
import type { ProviderExchangeAttempt, ProviderExchangePublicationContext,
} from '../../../contracts/provider-exchange.js';
import { throwIfPublicationOutcomeUnknown } from '../../../contracts/index.js';
import type { ConversationSessionId } from '../../../schemas/index.js';
import type { LlmInvocationInput } from '../llm-invocation.js';
import type { Candidate } from '../../../contracts/provider-candidate.js';
import type { EffectiveProviderCapabilities } from '../../../agents/provider-capabilities.js';

export const SUMMARY_COMPLETION_TOKENS = 2000;
const SUMMARY_OUTPUT_MAX_BYTES = 12_000;

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
      totalEstimatedTokens: number;
    }>
  | Readonly<{ kind: 'too_large'; estimatedInputTokens: number; totalEstimatedTokens: number }>;

export function admitSummaryRequest(args: {
  serialization: SummaryRequestSerialization;
  inputBudgetTokens: number;
  completionReserveTokens: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
}): SummaryRequestAdmission {
  if (SUMMARY_COMPLETION_TOKENS > args.completionReserveTokens)
    throw new Error(
      `The fixed ${SUMMARY_COMPLETION_TOKENS}-token summary completion request exceeds the configured completion reserve (${args.completionReserveTokens} tokens).`,
    );
  if (SUMMARY_COMPLETION_TOKENS > args.maxOutputTokens)
    throw new Error(`The fixed ${SUMMARY_COMPLETION_TOKENS}-token summary completion request exceeds the candidate output limit (${args.maxOutputTokens} tokens).`);
  const totalEstimatedTokens = args.serialization.estimatedInputTokens + SUMMARY_COMPLETION_TOKENS;
  if (totalEstimatedTokens > Math.min(args.inputBudgetTokens, Math.floor(0.8 * args.contextWindowTokens)))
    return {
      kind: 'too_large',
      estimatedInputTokens: args.serialization.estimatedInputTokens,
      totalEstimatedTokens,
    };
  return {
    kind: 'admitted',
    serializedRequest: args.serialization.serializedRequest,
    requestSha256: args.serialization.requestSha256,
    estimatedInputTokens: args.serialization.estimatedInputTokens,
    totalEstimatedTokens,
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
  return validateSummaryResult(completion.result);
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
    throw error;
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
  constructor(message: string) {
    super(message);
    this.name = 'SummaryResultValidationError';
  }
}

function validateSummaryResult(result: LlmCompleteResult): string {
  if (result.kind !== 'message')
    throw new SummaryResultValidationError('Summary refine expected prose summary text, got tool calls.');
  const text = result.content.trim();
  if (!text) throw new SummaryResultValidationError('Summary refine returned an empty summary.');
  if (/Recoverable evidence/i.test(text))
    throw new SummaryResultValidationError(
      'Summary refine output must be prose only; recoverable evidence is rendered by the compactor.',
    );
  if (Buffer.byteLength(text, 'utf8') > SUMMARY_OUTPUT_MAX_BYTES)
    throw new SummaryResultValidationError(`Summary refine output exceeds the ${SUMMARY_OUTPUT_MAX_BYTES}-byte UTF-8 limit.`);
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
