import type { AgentName } from '../schemas/index.js';
import type { LlmCompleteOptions, LlmModelParams, ToolDefinition } from './llm-contracts.js';

export function buildLlmOptions(
  agentName: AgentName,
  tools: ToolDefinition[],
  terminalToolOffered: readonly string[],
  modelParams: LlmModelParams,
  signal: AbortSignal | undefined,
  inputId: string,
): LlmCompleteOptions {
  return {
    inputId,
    temperature: modelParams.temperature,
    max_tokens: modelParams.max_tokens,
    signal,
    stream: false as const,
    contract_id: `${agentName}.v1`,
    contractName: agentName,
    terminalToolOffered,
    tools,
    tool_choice: 'auto',
  };
}
