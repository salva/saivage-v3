import { randomUUID } from 'node:crypto';
import type { LlmCompleteResult, ProviderTurnCompletion } from '../../../agents/llm-contracts.js';
import type { AgentMessage } from '../../../schemas/index.js';
import type { LlmInvocationInput } from '../llm-invocation.js';
import { validateConversationRows } from '../../../contracts/conversation-compaction.js';
import { providerConversationProjection } from '../conversation-session.js';

export interface SummarizerProviderPort { completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion> }
export type MergeSummaryInput = { round_id: string; summary_text: string };

export async function summarizeRound(args: { sourceSessionId: string; round_id: string; rows: AgentMessage[]; summarizerProvider: SummarizerProviderPort; signal: AbortSignal }): Promise<string> {
  if (args.rows.some((row) => row.kind === 'context_compaction')) throw new Error('summarizeRound must receive immutable non-metadata source rows only.');
  const providerConversation = providerConversationProjection(validateConversationRows(args.sourceSessionId, args.rows));
  const completion = await args.summarizerProvider.completeTurn(buildSummaryInput(randomUUID(), `summary:${args.round_id}`, 'Summarize this Saivage conversation round as concise prose. Preserve initial and repair segment order. Do not include recoverable-evidence pointer sections.', providerConversation), args.signal);
  args.signal.throwIfAborted();
  return validateSummaryResult(completion.result, 'summarizeRound');
}

export async function summarizeMerge(args: { entries: MergeSummaryInput[]; summarizerProvider: SummarizerProviderPort; signal: AbortSignal }): Promise<string> {
  if (args.entries.length === 0) throw new Error('summarizeMerge requires at least one summary.');
  const now = new Date().toISOString();
  const rows: AgentMessage[] = args.entries.map((entry, index) => ({ id: `summary-merge:${randomUUID()}`, session_id: 'summary:merge', role: 'user', kind: 'text', content: `Round ${entry.round_id}:\n${entry.summary_text}`, round_id: 'r-user-00000000000000000000000000000000', message_index: index, block_index: 0, timestamp: now }));
  const providerConversation = providerConversationProjection(validateConversationRows('summary:merge', rows));
  const completion = await args.summarizerProvider.completeTurn(buildSummaryInput(randomUUID(), 'summary:merge', 'Merge these ordered Saivage round summaries into one concise historical summary. Do not include recoverable-evidence pointer sections.', providerConversation), args.signal);
  args.signal.throwIfAborted();
  return validateSummaryResult(completion.result, 'summarizeMerge');
}

function buildSummaryInput(inputId: string, sessionId: string, systemPrompt: string, providerConversation: LlmInvocationInput['providerConversation']): LlmInvocationInput {
  return { inputId, agentId: 'llm:compaction-summarizer', role: 'analyst', sessionId, systemPrompt, providerConversation, tools: [], terminalToolNames: [], modelParams: { temperature: 0, maxTokens: 2000 }, capabilityRequest: {}, episodeContext: { compaction: true } };
}

function validateSummaryResult(result: LlmCompleteResult, caller: string): string {
  if (result.kind !== 'message') throw new Error(`${caller} expected prose summary text, got tool calls.`);
  const text = result.content.trim();
  if (!text) throw new Error(`${caller} returned an empty summary.`);
  if (/Recoverable evidence/i.test(text)) throw new Error(`${caller} output must be prose only; recoverable evidence is rendered by the compactor.`);
  return text;
}
