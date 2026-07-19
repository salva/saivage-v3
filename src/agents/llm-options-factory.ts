import type { OperationalAgentRole } from '../schemas/index.js';
import type { ProviderExchangeRecorder } from './provider-exchange-recorder.js';
import type {
  LlmCompleteOptions,
  LlmModelParams,
  ToolDefinition,
} from './llm-contracts.js';

export function buildLlmOptions(
  role: OperationalAgentRole,
  tools: ToolDefinition[],
  terminalToolOffered: readonly string[],
  modelParams: LlmModelParams,
  signal: AbortSignal | undefined,
  inputId: string,
  recorder?: ProviderExchangeRecorder,
): LlmCompleteOptions {
  return {
    inputId,
    temperature: modelParams.temperature,
    max_tokens: modelParams.max_tokens,
    signal,
    recorder,
    stream: false as const,
    contract_id: `${role}.v1`,
    contractName: role,
    terminalToolOffered,
    tools,
    tool_choice: 'auto',
  };
}
