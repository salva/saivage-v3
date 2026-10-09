import {
  ProcessToolResultSchema,
  ProcessViewSchema,
  type ProcessToolResult,
  type ProcessView,
} from '../../contracts/index.js';
import { redactCommandForOperator } from '../../workspace/index.js';
import { redactTextForOutbound } from '../../redaction/index.js';

type ProcessOutboundValue = ProcessView | ProcessToolResult;

export function projectProcessForOutbound<Value extends ProcessOutboundValue>(value: Value): Value {
  if ('process_id' in value) return ProcessToolResultSchema.parse(value) as Value;

  const process = ProcessViewSchema.parse(value);
  return ProcessViewSchema.parse({
    ...process,
    command: redactCommandForOperator(process.command),
    evidence: {
      ...process.evidence,
      group_diagnostic:
        process.evidence.group_diagnostic === null
          ? null
          : redactTextForOutbound(process.evidence.group_diagnostic),
      leader_error:
        process.evidence.leader_error === null
          ? null
          : {
              ...process.evidence.leader_error,
              diagnostic: redactTextForOutbound(process.evidence.leader_error.diagnostic),
            },
      stdout_error:
        process.evidence.stdout_error === null
          ? null
          : redactTextForOutbound(process.evidence.stdout_error),
      stderr_error:
        process.evidence.stderr_error === null
          ? null
          : redactTextForOutbound(process.evidence.stderr_error),
    },
  }) as Value;
}
