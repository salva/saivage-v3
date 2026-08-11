import { randomUUID } from 'node:crypto';
import { ProviderTurnFailure, type LlmCompleteResult, type ProviderTurnCompletion,
} from '../../../agents/llm-contracts.js';
import type { ProviderExchangeAttempt, ProviderExchangePublicationContext,
} from '../../../contracts/provider-exchange.js';
import { conversationSessionIdentity,globalAgentSessionId,type ConversationSessionId,
} from '../../../schemas/index.js';
import type { LlmInvocationInput } from '../llm-invocation.js';
import type { Candidate } from '../../../contracts/provider-candidate.js';
import type { ValidatedConversation } from '../../../contracts/conversation-validation.js';
import {
  summarizerConversationProjection,
  type SummarizerConversationProjection,
} from '../conversation-session.js';
import { throwIfPublicationOutcomeUnknown } from '../../../contracts/index.js';
import { buildSummarizerProviderRows } from './result-dropping.js';

export interface SummarizerProviderPort {
  readonly candidate: Candidate;
  completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion>;
  projectProviderExchanges(sessionId: string, sourceInputId: string, attempts: ProviderExchangeAttempt[], context: ProviderExchangePublicationContext,
  ): void;
}
export type MergeSummaryInput = { round_id: string; summary_text: string };

export class SummaryResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SummaryResultValidationError';
  }
}

export type SummarizerRoundInput = Readonly<{ sourceSessionId: ConversationSessionId;
  roundId: string;
  durableSourceRows: readonly string[];
  providerConversation: SummarizerConversationProjection;
}>;

export function buildSummarizerRoundInput(
  conversation: ValidatedConversation,
  roundId: string,
  rows: readonly { id: string }[],
): SummarizerRoundInput {
  const round = conversation.rounds.find((candidate) => candidate.label === roundId);
  if (!round)
    throw new Error(`Summarizer source round '${roundId}' is not a validated canonical round.`);
  const selectedIds = rows.map((row) => row.id);
  const canonicalPrefix = round.rows.slice(0, selectedIds.length);
  if (
    selectedIds.length === 0 ||
    JSON.stringify(selectedIds) !== JSON.stringify(canonicalPrefix.map((row) => row.id))
  ) {
    throw new Error(`Summarizer source rows are not the canonical prefix of round '${roundId}'.`);
  }
  const transformed = buildSummarizerProviderRows(canonicalPrefix);
  return Object.freeze({
    sourceSessionId: conversation.sourceSessionId,
    roundId,
    durableSourceRows: Object.freeze(selectedIds),
    providerConversation: summarizerConversationProjection(
      conversation.sourceSessionId,
      transformed,
    ),
  });
}

export async function summarizeRound(args: {
  input: SummarizerRoundInput;
  summarizerProvider: SummarizerProviderPort;
  signal: AbortSignal;
}): Promise<string> {
  args.signal.throwIfAborted();
  const completion = await invokeSummaryTurn(buildSummaryInput(randomUUID(), globalAgentSessionId('compaction-summarizer'), 'Summarize this Saivage conversation round as concise prose. Preserve initial and repair segment order. Do not include recoverable-evidence pointer sections.',
      args.input.providerConversation,args.summarizerProvider.candidate,
    ), args.summarizerProvider, args.signal,
  );
  args.signal.throwIfAborted();
  return validateSummaryResult(completion.result, 'summarizeRound');
}

export async function summarizeMerge(args: { entries: MergeSummaryInput[]; summarizerProvider: SummarizerProviderPort; signal: AbortSignal;
}): Promise<string> {
  if (args.entries.length === 0) throw new Error('summarizeMerge requires at least one summary.');
  args.signal.throwIfAborted();
  const orderedSummaries = args.entries.map((entry) => `Round ${entry.round_id}:\n${entry.summary_text}`)
    .join('\n\n');
  const completion = await invokeSummaryTurn(
    buildSummaryInput(
      randomUUID(),
      globalAgentSessionId('compaction-summarizer'),
      `Merge these ordered Saivage round summaries into one concise historical summary. Do not include recoverable-evidence pointer sections.\n\n${orderedSummaries}`,
      { sourceSessionId: null, messages: [] },
      args.summarizerProvider.candidate,
    ),
    args.summarizerProvider,
    args.signal,
  );
  args.signal.throwIfAborted();
  return validateSummaryResult(completion.result, 'summarizeMerge');
}

async function invokeSummaryTurn(
  input: LlmInvocationInput,
  provider: SummarizerProviderPort,
  signal: AbortSignal,
): Promise<ProviderTurnCompletion> {
  try {
    const completion = await provider.completeTurn(input, signal);
    projectSummaryExchanges(provider, input, completion.provider_exchanges);
    return completion;
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (!(error instanceof ProviderTurnFailure)) throw error;
    projectSummaryExchanges(provider, input, error.provider_exchanges);
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

function buildSummaryInput(
  inputId: string,
  sessionId: ConversationSessionId,
  systemPrompt: string,
  providerConversation: LlmInvocationInput['providerConversation'],
  candidate: Candidate,
): LlmInvocationInput {
  return {
    inputId,
    agentId: 'llm:compaction-summarizer',
    agentName: conversationSessionIdentity(sessionId).agentName,
    sessionId,
    systemPrompt,
    providerConversation,
    tools: [],
    terminalToolNames: [],
    modelParams: { temperature: 0, maxTokens: 2000 },
    capabilityRequest: { requiresTools: false, requiresExclusiveToolChoice: true, streaming: false },
    routePass: { kind: 'ordinary', candidateChain: [candidate] },
    episodeContext: { compaction: true },
  };
}

function validateSummaryResult(result: LlmCompleteResult, caller: string): string {
  if (result.kind !== 'message')
    throw new SummaryResultValidationError(`${caller} expected prose summary text, got tool calls.`);
  const text = result.content.trim();
  if (!text) throw new SummaryResultValidationError(`${caller} returned an empty summary.`);
  if (/Recoverable evidence/i.test(text))
    throw new SummaryResultValidationError(
      `${caller} output must be prose only; recoverable evidence is rendered by the compactor.`,
    );
  return text;
}
