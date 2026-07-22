import { loggedEventSchema, type LoggedEvent } from '../schemas/index.js';
import { projectDynamicForOutbound } from '../redaction/dynamic.js';
import { redactTextForOutbound } from '../redaction/text.js';

export function projectLoggedEvent(event: LoggedEvent): LoggedEvent {
  const parsed = loggedEventSchema.parse(event);
  switch (parsed.kind) {
    case 'runtime_diagnostic':
      return loggedEventSchema.parse({ ...parsed, error_message: redactTextForOutbound(parsed.error_message) });
    case 'mcp_tool_invocation':
      return loggedEventSchema.parse({
        ...parsed,
        ...(parsed.error !== undefined ? { error: redactTextForOutbound(parsed.error) } : {}),
      });
    case 'runtime_actionable_error': {
      const actionable = parsed.actionable_error;
      return loggedEventSchema.parse({
        ...parsed,
        actionable_error: {
          ...actionable,
          message: redactTextForOutbound(actionable.message),
          nextAction: redactTextForOutbound(actionable.nextAction),
          ...(actionable.currentState !== undefined
            ? { currentState: projectCurrentState(actionable.code, actionable.currentState) }
            : {}),
        },
      });
    }
  }
}

function projectCurrentState(code: string, state: Record<string, unknown>): Record<string, unknown> {
  switch (code) {
    case 'contract_response_violation': {
      assertExactKeys(state, ['failureCode', 'operation', 'statusCode']);
      if (typeof state.operation !== 'string' || typeof state.failureCode !== 'string' || !Number.isInteger(state.statusCode)) {
        throw new Error('contract_response_violation currentState has invalid fields.');
      }
      return { operation: state.operation, statusCode: state.statusCode, failureCode: state.failureCode };
    }
    case 'invalid_enum_value': {
      assertExactKeys(state, ['field', 'value']);
      if (typeof state.field !== 'string') throw new Error('invalid_enum_value currentState.field must be a string.');
      return { field: state.field, value: projectDynamicForOutbound(state.value) };
    }
    default:
      throw new Error(`Actionable error code ${code} has an unclassified currentState.`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Actionable error currentState keys must be exactly: ${expected.join(', ')}.`);
  }
}
