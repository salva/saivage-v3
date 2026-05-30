import { LlmRequestError } from './llm-failure.js';
import { type PersistedToolCall } from './persisted-tool-call.js';
import { ENVELOPE_SCHEMAS, type EnvelopeBearingRole } from './role-envelope-schemas.js';
import { ROLE_RESULT_TOOL_NAMES } from './role-result-tools.js';

export function validateTerminalToolCall(call: PersistedToolCall | undefined, role: EnvelopeBearingRole): Record<string, unknown> {
  if (call === undefined) {
    throw new LlmRequestError({
      kind: 'provider_protocol_error',
      provider: 'gateway-protocol',
      status: 0,
      message: `terminal tool call missing for role ${role}`,
    });
  }
  const expectedName = ROLE_RESULT_TOOL_NAMES[role];
  if (call.name !== expectedName) {
    throw new LlmRequestError({
      kind: 'provider_protocol_error',
      provider: 'gateway-protocol',
      status: 0,
      message: `terminal tool call for role ${role} has unexpected name "${call.name}" (expected "${expectedName}")`,
    });
  }
  const result = ENVELOPE_SCHEMAS[role].safeParse(call.args);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new LlmRequestError({
      kind: 'provider_protocol_error',
      provider: 'gateway-protocol',
      status: 0,
      message: `terminal tool call for role ${role} failed schema validation: ${summary}`,
    });
  }
  return result.data as Record<string, unknown>;
}
