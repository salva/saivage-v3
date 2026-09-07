import { canonicalJson } from '../schemas/index.js';
import { ToolResultSchema, assertToolActionOutcome, toolSucceeded, type ToolActionOutcome, type ToolResult } from '../contracts/tool-result.js';
import { projectDynamicForOutbound } from '../redaction/dynamic.js';

interface SettledToolResultProjection {
  readonly providerResult: ToolResult;
  readonly settledResultBytes: string;
}

function projectOutcome(outcome: ToolActionOutcome): ToolResult {
  assertToolActionOutcome(outcome);
  return ToolResultSchema.parse(outcome.kind === 'succeeded'
    ? { success: true, ...(outcome.data === undefined ? {} : { data: projectDynamicForOutbound(outcome.data) }) }
    : { success: false, error: projectDynamicForOutbound(outcome.error), ...(outcome.data === undefined ? {} : { data: projectDynamicForOutbound(outcome.data) }) });
}

export function settleToolActionOutcome(outcome: ToolActionOutcome): SettledToolResultProjection {
  const providerResult = projectOutcome(outcome);
  return Object.freeze({ providerResult, settledResultBytes: canonicalJson(providerResult) });
}

export function settledSuccessBytes(data: unknown): string {
  return settleToolActionOutcome(toolSucceeded(data)).settledResultBytes;
}

export function projectHistoricalToolResultForOutbound(value: unknown): ToolResult {
  const result = ToolResultSchema.parse(value);
  return ToolResultSchema.parse(result.success
    ? { success: true, ...(result.data === undefined ? {} : { data: projectDynamicForOutbound(result.data) }) }
    : { success: false, error: projectDynamicForOutbound(result.error), ...(result.data === undefined ? {} : { data: projectDynamicForOutbound(result.data) }) });
}
