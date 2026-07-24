import { randomUUID } from 'node:crypto';
import { ProviderTurnFailure, type LlmCompleteResult, type ProviderTurnCompletion } from '../../../agents/llm-contracts.js';
import type { ProviderExchangeAttempt } from '../../../contracts/provider-exchange.js';
import { conversationSessionIdentity,globalAgentSessionId,type AgentMessage, type ConversationSessionId } from '../../../schemas/index.js';
import type { LlmInvocationInput } from '../llm-invocation.js';
import { validateConversationRows } from '../../../contracts/conversation-compaction.js';
import { providerConversationProjection } from '../conversation-session.js';
import { throwIfPublicationOutcomeUnknown } from '../../../contracts/index.js';

export interface SummarizerProviderPort {
  completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion>;
  projectProviderExchanges(sessionId: string, sourceInputId: string, attempts: ProviderExchangeAttempt[], assistantOutputIds: string[]): void;
}
export type MergeSummaryInput = { round_id: string; summary_text: string };

export async function summarizeRound(args: { sourceSessionId: ConversationSessionId; round_id: string; rows: AgentMessage[]; summarizerProvider: SummarizerProviderPort; signal: AbortSignal }): Promise<string> {
  if (args.rows.some((row) => row.kind === 'context_compaction')) throw new Error('summarizeRound must receive immutable non-metadata source rows only.');
  const providerConversation = providerConversationProjection(validateConversationRows(args.sourceSessionId, args.rows));
  const completion = await invokeSummaryTurn(buildSummaryInput(randomUUID(), globalAgentSessionId('compaction-summarizer'), 'Summarize this Saivage conversation round as concise prose. Preserve initial and repair segment order. Do not include recoverable-evidence pointer sections.', providerConversation), args.summarizerProvider, args.signal);
  args.signal.throwIfAborted();
  return validateSummaryResult(completion.result, 'summarizeRound');
}

export async function summarizeMerge(args: { entries: MergeSummaryInput[]; summarizerProvider: SummarizerProviderPort; signal: AbortSignal }): Promise<string> {
  if (args.entries.length === 0) throw new Error('summarizeMerge requires at least one summary.');
  const orderedSummaries = args.entries.map((entry) => `Round ${entry.round_id}:\n${entry.summary_text}`).join('\n\n');
  const completion = await invokeSummaryTurn(buildSummaryInput(randomUUID(), globalAgentSessionId('compaction-summarizer'), `Merge these ordered Saivage round summaries into one concise historical summary. Do not include recoverable-evidence pointer sections.\n\n${orderedSummaries}`, { sourceSessionId: null, messages: [] }), args.summarizerProvider, args.signal);
  args.signal.throwIfAborted();
  return validateSummaryResult(completion.result, 'summarizeMerge');
}

async function invokeSummaryTurn(input: LlmInvocationInput, provider: SummarizerProviderPort, signal: AbortSignal): Promise<ProviderTurnCompletion> {
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
  provider.projectProviderExchanges(input.sessionId, input.inputId, attempts, []);
}

function buildSummaryInput(inputId: string, sessionId: ConversationSessionId, systemPrompt: string, providerConversation: LlmInvocationInput['providerConversation']): LlmInvocationInput {
  return { inputId, agentId: 'llm:compaction-summarizer', agentName:conversationSessionIdentity(sessionId).agentName, sessionId, systemPrompt, providerConversation, tools: [], terminalToolNames: [], modelParams: { temperature: 0, maxTokens: 2000 }, capabilityRequest: {}, episodeContext: { compaction: true } };
}

function validateSummaryResult(result: LlmCompleteResult, caller: string): string {
  if (result.kind !== 'message') throw new Error(`${caller} expected prose summary text, got tool calls.`);
  const text = result.content.trim();
  if (!text) throw new Error(`${caller} returned an empty summary.`);
  if (/Recoverable evidence/i.test(text)) throw new Error(`${caller} output must be prose only; recoverable evidence is rendered by the compactor.`);
  return text;
}
