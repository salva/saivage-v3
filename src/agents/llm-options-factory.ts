import type { OperationalAgentRole } from '../schemas/index.js';
import type { LlmExchangeRecorder } from './llm-exchange-recorder.js';
import type {
  LlmCompleteOptions,
  LlmCompleteOptionsTerminal,
  LlmCompleteOptionsTools,
  LlmModelParams,
  ToolDefinition,
} from './llm-contracts.js';
import { ROLE_RESULT_TOOL_NAMES } from './role-result-tools.js';
import type { EnvelopeBearingRole } from './role-envelope-schemas.js';

const ROLE_RESULT_TOOL_NAMES_VALUES: readonly string[] = Object.values(ROLE_RESULT_TOOL_NAMES);

export type LlmRolePhase = 'tools' | 'terminal';

function isEnvelopeBearing(role: OperationalAgentRole): role is EnvelopeBearingRole {
  return role === 'planner' || role === 'executor' || role === 'reviewer';
}

export function buildLlmOptions(
  role: OperationalAgentRole,
  phase: LlmRolePhase,
  tools: ToolDefinition[],
  modelParams: LlmModelParams,
  signal: AbortSignal | undefined,
  recorder?: LlmExchangeRecorder,
): LlmCompleteOptions {
  const base = {
    temperature: modelParams.temperature,
    max_tokens: modelParams.max_tokens,
    signal,
    recorder,
    stream: false as const,
    contract_id: `${role}.v1`,
    contractName: role,
    terminalToolOffered:
      phase === 'terminal' && isEnvelopeBearing(role)
        ? [ROLE_RESULT_TOOL_NAMES[role]]
        : tools.filter((t) => ROLE_RESULT_TOOL_NAMES_VALUES.includes(t.function.name)).map((t) => t.function.name),
  };

  if (phase === 'tools') {
    const opts: LlmCompleteOptionsTools = {
      ...base,
      phase: 'tools',
      tools,
      tool_choice: { kind: 'auto' },
    };
    return opts;
  }

  // phase === 'terminal'
  if (!isEnvelopeBearing(role)) {
    throw new Error(`buildLlmOptions: role '${role}' is not envelope-bearing; cannot construct terminal phase`);
  }
  const expectedName = ROLE_RESULT_TOOL_NAMES[role];
  if (tools.length !== 1) {
    throw new Error(`buildLlmOptions: terminal phase for role '${role}' requires exactly one tool (got ${tools.length})`);
  }
  const terminalTool = tools[0];
  if (terminalTool.function.name !== expectedName) {
    throw new Error(`buildLlmOptions: terminal phase for role '${role}' requires tool '${expectedName}' (got '${terminalTool.function.name}')`);
  }
  const opts: LlmCompleteOptionsTerminal = {
    ...base,
    phase: 'terminal',
    terminalToolName: expectedName,
    terminalToolDefinition: terminalTool,
  };
  return opts;
}

export function deriveTerminalTool(opts: LlmCompleteOptions): string | null {
  if (opts.phase === 'terminal') return opts.terminalToolName;
  if (opts.tool_choice.kind === 'required_named') return opts.tool_choice.toolName;
  return null;
}
