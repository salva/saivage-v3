import { LlmRequestError } from './llm-failure.js';
import { parseToolCallArgsAgainstSchema, type PersistedToolCall } from './persisted-tool-call.js';
import { ENVELOPE_SCHEMAS, type EnvelopeBearingRole } from './role-envelope-schemas.js';
import { ROLE_RESULT_TOOL_NAMES } from './role-result-tools.js';

export function validateTerminalToolCall(call: PersistedToolCall | undefined, role: EnvelopeBearingRole): Record<string, unknown> {
  if (call === undefined) {
    throw new LlmRequestError({
      kind: 'contract_mismatch',
      subtype: 'terminal_tool_missing',
      provider: 'gateway-protocol',
      message: `terminal tool call missing for role ${role}`,
    });
  }
  const expectedName = ROLE_RESULT_TOOL_NAMES[role];
  if (call.name !== expectedName) {
    throw new LlmRequestError({
      kind: 'contract_mismatch',
      subtype: 'terminal_tool_unexpected',
      provider: 'gateway-protocol',
      message: `terminal tool call for role ${role} has unexpected name "${call.name}" (expected "${expectedName}")`,
    });
  }
  return parseToolCallArgsAgainstSchema(call.args, ENVELOPE_SCHEMAS[role]);
}
