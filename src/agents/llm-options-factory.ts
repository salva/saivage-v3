import type { OperationalAgentRole } from '../schemas/index.js';
import type { LlmExchangeRecorder } from './llm-exchange-recorder.js';
import type {
  LlmCompleteOptionsTools,
  LlmModelParams,
  ToolDefinition,
} from './llm-contracts.js';

export function buildLlmOptions(
  role: OperationalAgentRole,
  tools: ToolDefinition[],
  terminalToolOffered: readonly string[],
  modelParams: LlmModelParams,
  signal: AbortSignal | undefined,
  recorder?: LlmExchangeRecorder,
): LlmCompleteOptionsTools {
  return {
    temperature: modelParams.temperature,
    max_tokens: modelParams.max_tokens,
    signal,
    recorder,
    stream: false as const,
    contract_id: `${role}.v1`,
    contractName: role,
    terminalToolOffered,
    phase: 'tools',
    tools,
    tool_choice: { kind: 'auto' },
  };
}
