import type { AgentName } from '../../schemas/index.js';
import { redactTextForOutbound } from '../../redaction/index.js';

interface AgentProtocolViolation {
  kind: 'agent_protocol_violation';
  session_id: string;
  agent_name: AgentName;
  provider?: string;
  model?: string;
  tool_call_id?: string;
  tool_name?: string;
  violation:
    | 'tool_args_invalid_json'
    | 'tool_args_not_object'
    | 'terminal_args_not_object'
    | 'internal_tool_result_malformed';
  raw_preview: string;
}

const RAW_PREVIEW_LIMIT = 500;

function rawProtocolPreview(raw: string): string {
  const redacted = redactTextForOutbound(raw);
  return redacted.length <= RAW_PREVIEW_LIMIT
    ? redacted
    : `${redacted.slice(0, RAW_PREVIEW_LIMIT)}...[truncated ${redacted.length - RAW_PREVIEW_LIMIT} chars]`;
}

export function buildAgentProtocolViolation(
  input: Omit<AgentProtocolViolation, 'kind' | 'raw_preview'> & { raw: string },
): AgentProtocolViolation {
  return {
    kind: 'agent_protocol_violation',
    session_id: input.session_id,
    agent_name: input.agent_name,
    provider: input.provider,
    model: input.model,
    tool_call_id: input.tool_call_id,
    tool_name: input.tool_name,
    violation: input.violation,
    raw_preview: rawProtocolPreview(input.raw),
  };
}
