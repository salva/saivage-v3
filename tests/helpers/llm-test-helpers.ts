import type { LlmCompleteOptions, LlmCompleteResult, ProviderTurnCompletion, ToolCall } from '../../src/agents/llm-contracts.js';
import { compact, shouldCompact, type AutonomousCompactionPolicy } from '../../src/runtime/actors/compaction/compactor.js';
import type { CompactorPort } from '../../src/runtime/actors/llm-actor.js';
import type { SummarizerProviderPort } from '../../src/runtime/actors/compaction/summarizer.js';

export const testCompactionPolicy: AutonomousCompactionPolicy = {
  input_budget_tokens: 100_000,
  trigger_fraction: 0.8,
  completion_reserve_fraction: 0.2,
  merge_line_fraction: 0.3,
  summary_line_fraction: 0.5,
  escalate_merge_line_fraction: 0.4,
  escalate_summary_line_fraction: 0.6,
  snap: 'compact_straddler',
};

export const testCompactor: CompactorPort = { shouldCompact, compact };
export const unusedSummarizerProvider: SummarizerProviderPort = {
  completeTurn: () => Promise.reject(new Error('Unexpected summarizer call in test.')),
  projectProviderExchanges: () => { throw new Error('Unexpected summarizer exchange projection in test.'); },
};

export const testAutonomousCompaction = {
  compactor: testCompactor,
  compactionConfig: testCompactionPolicy,
  summarizerProvider: unusedSummarizerProvider,
};

export function toolsOpts(extra: Partial<LlmCompleteOptions> = {}): LlmCompleteOptions {
  return { inputId: 'test:input:1', phase: 'tools', tools: [], tool_choice: { kind: 'auto' }, contract_id: 'test.v1', contractName: 'test', terminalToolOffered: [], ...(extra as object) } as LlmCompleteOptions;
}

export function asMessage(value: LlmCompleteResult | ProviderTurnCompletion): { content: string; tool_calls: ToolCall[]; finishReason: string } {
  const r = 'result' in value ? value.result : value;
  if (r.kind === 'message') return { content: r.content, tool_calls: [], finishReason: 'stop' };
  return { content: '', tool_calls: r.tool_calls, finishReason: 'tool_calls' };
}

export function makeCodexJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url');
  return `${header}.${payload}.sig`;
}
