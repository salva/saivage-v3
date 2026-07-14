import type { LlmCompleteResult, ProviderTurnCompletion } from '../../../agents/llm-contracts.js';
import type { AgentMessage } from '../../../schemas/index.js';
import type { LlmInvocationInput } from '../llm-invocation.js';
import type { SummaryCacheEntry } from './summary-cache.js';
import { buildResponsesReplayProjection } from '../../../agents/llm-openai-responses-mapper.js';

export interface SummarizerProviderPort {
  completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion>;
}

export type SummarizerModelSpec = string;

export async function summarizeRound(args: {
  round_id: string;
  rows: AgentMessage[];
  summarizerProvider: SummarizerProviderPort;
  modelSpec: SummarizerModelSpec;
  signal: AbortSignal;
}): Promise<string> {
  validateNoCompactionRows(args.rows, 'summarizeRound');
  const completion = await args.summarizerProvider.completeTurn(buildSummaryInput({
    inputId: `summary-round:${args.round_id}`,
    sessionId: `summary:${args.round_id}`,
    modelSpec: args.modelSpec,
    systemPrompt: 'Summarize this Saivage conversation round as concise prose. Do not include recoverable-evidence pointer sections.',
    contextMessages: args.rows,
  }), args.signal);
  args.signal.throwIfAborted();
  return validateSummaryResult(completion.result, 'summarizeRound');
}

export async function summarizeMerge(args: {
  entries: SummaryCacheEntry[];
  summarizerProvider: SummarizerProviderPort;
  modelSpec: SummarizerModelSpec;
  signal: AbortSignal;
}): Promise<string> {
  if (args.entries.length === 0) throw new Error('summarizeMerge requires at least one cached summary entry.');
  const contextMessages = args.entries.map((entry, index) => ({
    id: `summary-merge:${entry.cache_key}`,
    session_id: 'summary:merge',
    role: 'user' as const,
    kind: 'text' as const,
    content: `Cached round summary ${index + 1} (${entry.round_id}):\n${entry.summary_text}`,
    round_id: 'r-user-00000000000000000000000000000000',
    message_index: index,
    block_index: 0,
    timestamp: entry.created_at,
  }));
  const completion = await args.summarizerProvider.completeTurn(buildSummaryInput({
    inputId: 'summary-merge',
    sessionId: 'summary:merge',
    modelSpec: args.modelSpec,
    systemPrompt: 'Merge these cached Saivage round summaries into one concise prose summary. Do not include recoverable-evidence pointer sections.',
    contextMessages,
  }), args.signal);
  args.signal.throwIfAborted();
  return validateSummaryResult(completion.result, 'summarizeMerge');
}

function buildSummaryInput(args: { inputId: string; sessionId: string; modelSpec: string; systemPrompt: string; contextMessages: AgentMessage[] }): LlmInvocationInput {
  return {
    inputId: args.inputId,
    agentId: 'llm:compaction-summarizer',
    role: 'analyst',
    sessionId: args.sessionId,
    systemPrompt: `${args.systemPrompt}\nModel: ${args.modelSpec}`,
    genericContextMessages: args.contextMessages,
    contextMessages: args.contextMessages,
    activeConversationReplay: buildResponsesReplayProjection(args.sessionId, args.contextMessages),
    tools: [],
    terminalToolNames: [],
    modelParams: { temperature: 0, maxTokens: 2000 },
    capabilityRequest: {},
    episodeContext: { compaction: true, model_spec: args.modelSpec },
  };
}

function validateNoCompactionRows(rows: AgentMessage[], caller: string): void {
  const found = rows.find((row) => row.kind === 'context_compaction');
  if (found) throw new Error(`${caller} must not receive non-model-visible compaction rows; found '${found.id}' kind '${found.kind}'.`);
}

function validateSummaryResult(result: LlmCompleteResult, caller: string): string {
  if (result.kind !== 'message') throw new Error(`${caller} expected prose summary text, got tool calls.`);
  const text = result.content.trim();
  if (!text) throw new Error(`${caller} returned an empty summary.`);
  if (/##\s*Recoverable evidence/i.test(text)) throw new Error(`${caller} output must be prose only; recoverable evidence is rendered by the compactor.`);
  return text;
}
