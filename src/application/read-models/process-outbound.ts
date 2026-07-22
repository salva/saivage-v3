import {
  ProcessToolResultSchema,
  ProcessViewSchema,
  type ProcessToolResult,
  type ProcessView,
} from '../../contracts/operator-api-processes.js';
import { redactCommandForOperator } from '../../workspace/index.js';

export type ProcessOutboundValue = ProcessView | ProcessToolResult;

export function projectProcessForOutbound<Value extends ProcessOutboundValue>(value: Value): Value {
  if ('process_id' in value) return ProcessToolResultSchema.parse(value) as Value;

  const process = ProcessViewSchema.parse(value);
  return ProcessViewSchema.parse({
    ...process,
    command: redactCommandForOperator(process.command),
  }) as Value;
}
