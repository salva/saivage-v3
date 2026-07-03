import type { LlmCompleteOptions, LlmCompleteResult, ToolCall } from '../../src/agents/llm-contracts.js';

export function toolsOpts(extra: Partial<LlmCompleteOptions> = {}): LlmCompleteOptions {
  return { phase: 'tools', tools: [], tool_choice: { kind: 'auto' }, contract_id: 'test.v1', contractName: 'test', terminalToolOffered: [], ...(extra as object) } as LlmCompleteOptions;
}

export function asMessage(r: LlmCompleteResult): { content: string; tool_calls: ToolCall[]; finishReason: string } {
  if (r.kind === 'message') return { content: r.content, tool_calls: [], finishReason: 'stop' };
  return { content: '', tool_calls: r.tool_calls, finishReason: 'tool_calls' };
}

export function makeCodexJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url');
  return `${header}.${payload}.sig`;
}
