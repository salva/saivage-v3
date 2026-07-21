import type { OperationalAgentRole } from '../schemas/index.js';
import { redactTextForOutbound } from '../redaction/index.js';

export interface AgentProtocolViolation {
  kind: 'agent_protocol_violation';
  session_id: string;
  role: OperationalAgentRole;
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

export function rawProtocolPreview(raw: string): string {
  const redacted = redactTextForOutbound(raw);
  return redacted.length <= RAW_PREVIEW_LIMIT
    ? redacted
    : `${redacted.slice(0, RAW_PREVIEW_LIMIT)}...[truncated ${redacted.length - RAW_PREVIEW_LIMIT} chars]`;
}

export function parseProtocolToolArgs(raw: string):
  | { kind: 'ok'; args: Record<string, unknown> }
  | { kind: 'violation'; violation: 'tool_args_invalid_json' | 'tool_args_not_object'; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: 'violation',
      violation: 'tool_args_invalid_json',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'violation',
      violation: 'tool_args_not_object',
      detail: `tool arguments must be a JSON object, got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`,
    };
  }
  return { kind: 'ok', args: parsed as Record<string, unknown> };
}

export function buildAgentProtocolViolation(input: Omit<AgentProtocolViolation, 'kind' | 'raw_preview'> & { raw: string }): AgentProtocolViolation {
  return {
    kind: 'agent_protocol_violation',
    session_id: input.session_id,
    role: input.role,
    provider: input.provider,
    model: input.model,
    tool_call_id: input.tool_call_id,
    tool_name: input.tool_name,
    violation: input.violation,
    raw_preview: rawProtocolPreview(input.raw),
  };
}
