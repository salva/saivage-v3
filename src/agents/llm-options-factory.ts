import { sha256Hex, type AgentName } from '../schemas/index.js';
import type { LlmCompleteOptions, LlmModelParams } from '../contracts/index.js';
import type { ToolDefinition } from '../contracts/index.js';

export function buildLlmOptions(
  agentName: AgentName,
  tools: ToolDefinition[],
  terminalToolOffered: readonly string[],
  modelParams: LlmModelParams,
  signal: AbortSignal | undefined,
  inputId: string,
  owner: { projectRoot: string; sessionId: string },
): LlmCompleteOptions {
  return {
    inputId,
    providerSessionId: sha256Hex(
      JSON.stringify(['saivage-provider-session', owner.projectRoot, owner.sessionId]),
    ),
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
