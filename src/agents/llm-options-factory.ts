import type { AgentName } from '../schemas/index.js';
import type { LlmCompleteOptions, LlmModelParams } from '../contracts/index.js';
import type { ToolDefinition } from '../contracts/index.js';

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
    contract_id: `${agentName}.v1`,
    contractName: agentName,
    terminalToolOffered,
    tools,
    tool_choice: 'auto',
  };
}
