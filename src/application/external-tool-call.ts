import { appendAppLogEntry } from '../persistence/index.js';
import { externalToolCallSchema, type ExternalToolCall } from '../contracts/index.js';
import type {
  InvocationSurface,
  ToolSettlementInput,
  ToolExecutionContext,
} from '../tools/tool-api.js';

/** Only known ordinary settlements reach this owner; no start row or recovery/replay. */
export function recordExternalToolCall(input: {
  projectRoot: string;
  projectIdentityDigest: string;
  context: Extract<ToolExecutionContext, { kind: 'external' }>;
  surface: InvocationSurface;
  requestedTool: string;
  settlement: ToolSettlementInput;
}): ExternalToolCall {
  const { settlement } = input;
  const outcome =
    settlement.kind === 'executed'
      ? settlement.execution.providerOutcome
      : settlement.providerOutcome;
  const denied =
    outcome.kind === 'failed' &&
    typeof outcome.data === 'object' &&
    outcome.data !== null &&
    'code' in outcome.data &&
    typeof outcome.data.code === 'string' &&
    [
      'record_mutation_denied',
      'record_open_conflict',
      'analyst_mutation_denied',
      'intervention_not_ready',
    ].includes(outcome.data.code);
  return appendAppLogEntry(input.projectRoot, 'external_tool_call', () => ({
    type: 'external_tool_call',
    data: {
      id: input.context.invocationId,
      principal: input.context.principal,
      project_identity_digest: input.projectIdentityDigest,
      tool: input.surface.tools.has(input.requestedTool) ? input.requestedTool : '<unsupported>',
      created_at: new Date().toISOString(),
      execution:
        settlement.kind === 'unsupported_tool' ? 'rejected_before_execution' : settlement.kind,
      outcome: outcome.kind === 'succeeded' ? 'ok' : denied ? 'denied' : 'error',
    },
  })).data;
}

/** Closed, body-free wire projection; never projects client metadata or exceptions. */
export function projectExternalToolCall(value: ExternalToolCall): ExternalToolCall {
  return externalToolCallSchema.parse(value);
}
