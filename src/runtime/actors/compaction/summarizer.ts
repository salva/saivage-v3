import { createHash, randomUUID } from 'node:crypto';
import { ProviderTurnFailure, type LlmCompleteResult, type ProviderTurnCompletion,
} from '../../../agents/llm-contracts.js';
import type { ProviderExchangeAttempt, ProviderExchangePublicationContext,
} from '../../../contracts/provider-exchange.js';
import { throwIfPublicationOutcomeUnknown } from '../../../contracts/index.js';
import {
  agentMessageSchema,
  DURABLE_PRIMARY_CONTENT_POLICY,
  type AgentMessage,
  type ConversationSessionId,
} from '../../../schemas/index.js';
import { deterministicRoundId } from '../../../schemas/round-id-server.js';
import type { LlmInvocationInput } from '../llm-invocation.js';
import type { Candidate } from '../../../contracts/provider-candidate.js';

export const SUMMARY_COMPLETION_TOKENS = 2000;

const INTERNAL_SUMMARY_LABEL = 'internal-compaction-summary';
const SUMMARY_REQUEST_EPOCH_TIMESTAMP = '1970-01-01T00:00:00.000Z';

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
  serializeSummaryRequest(input: LlmInvocationInput): SummaryRequestSerialization;
  completeTurn(input: LlmInvocationInput, admitted: SummaryRequestSerialization, signal: AbortSignal): Promise<ProviderTurnCompletion>;
  projectProviderExchanges(sessionId: string, sourceInputId: string, attempts: ProviderExchangeAttempt[], context: ProviderExchangePublicationContext,
  ): void;
}

export type SummaryRequestAdmission =
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
}): SummaryRequestAdmission {
  if (SUMMARY_COMPLETION_TOKENS > args.completionReserveTokens)
    throw new Error(
      `The fixed ${SUMMARY_COMPLETION_TOKENS}-token summary completion request exceeds the configured completion reserve (${args.completionReserveTokens} tokens).`,
    );
  const totalEstimatedTokens = args.serialization.estimatedInputTokens + SUMMARY_COMPLETION_TOKENS;
  if (totalEstimatedTokens > args.inputBudgetTokens)
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
  codeOwnedSemantic: string | null;
}>;

export function buildSummaryRequestInput(args: {
  candidate: Candidate;
  sourceSessionId: ConversationSessionId;
  instruction: string;
  items: readonly SummaryRequestItem[];
}): LlmInvocationInput {
  const messages: AgentMessage[] = args.items.map((item, index) =>
    agentMessageSchema.parse({
      id: `summary-item:${index + 1}`,
      session_id: args.sourceSessionId,
      role: item.role,
      kind: 'text',
      content: `[order ${index + 1}/${args.items.length}] ${item.label}\n${item.content}`,
      context_policy: DURABLE_PRIMARY_CONTENT_POLICY,
      round_id: deterministicRoundId('user', `${args.sourceSessionId}:summary-item:${index + 1}:${item.label}`),
      message_index: index,
      block_index: 0,
      timestamp: SUMMARY_REQUEST_EPOCH_TIMESTAMP,
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
    capabilityRequest: { requiresTools: false, requiresExclusiveToolChoice: true },
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
    throw new SummaryResultValidationError('Summary reduction expected prose summary text, got tool calls.');
  const text = result.content.trim();
  if (!text) throw new SummaryResultValidationError('Summary reduction returned an empty summary.');
  if (/Recoverable evidence/i.test(text))
    throw new SummaryResultValidationError(
      'Summary reduction output must be prose only; recoverable evidence is rendered by the compactor.',
    );
  return text;
}
