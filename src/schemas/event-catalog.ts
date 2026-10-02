import { z } from 'zod';

import { actionableErrorEnvelopeSchema } from './actionable-error.js';
import { cardIdSchema } from './card-id.js';
import { runtimeStatusSchema } from './validators.js';

const eventBaseShape = {
  id: z.string().min(1),
  timestamp: z.string().datetime(),
};

const runtimeDiagnosticEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('runtime_diagnostic'),
    goal_id: cardIdSchema.optional(),
    card_id: cardIdSchema.optional(),
    phase: z.string().optional(),
    error_message: z.string(),
  })
  .strict();

const runtimeActionableErrorEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('runtime_actionable_error'),
    actionable_error: actionableErrorEnvelopeSchema,
  })
  .strict();

const mcpToolInvocationEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('mcp_tool_invocation'),
    server: z.string(),
    tool: z.string(),
    success: z.boolean(),
    duration_ms: z.number().nonnegative(),
    error: z.string().optional(),
  })
  .strict();

const bodyRejectedShape = {
  outcome: z.literal('rejected'),
  reason: z.literal('body_not_allowed'),
};
const operatorRuntimeControlEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('operator_runtime_control'),
    actor: z.literal('operator'),
    surface: z.literal('operator_api'),
    result: z.union([
      z
        .object({
          operation: z.literal('pause_runtime'),
          outcome: z.literal('returned'),
          runtime_status: runtimeStatusSchema,
        })
        .strict(),
      z
        .object({
          operation: z.literal('resume_runtime'),
          outcome: z.literal('returned'),
          runtime_status: runtimeStatusSchema,
        })
        .strict(),
      z
        .object({
          operation: z.literal('stop_project'),
          outcome: z.literal('returned'),
          status: z.literal('stopped'),
          contained: z.boolean(),
        })
        .strict(),
      z
        .object({ operation: z.literal('restart_server'), outcome: z.literal('restart_scheduled') })
        .strict(),
      z
        .object({
          operation: z.enum(['pause_runtime', 'resume_runtime', 'stop_project']),
          ...bodyRejectedShape,
        })
        .strict(),
      z
        .object({
          operation: z.literal('restart_server'),
          outcome: z.literal('rejected'),
          reason: z.literal('restart_unavailable'),
        })
        .strict(),
    ]),
  })
  .strict();

export const loggedEventSchema = z.discriminatedUnion('kind', [
  runtimeDiagnosticEventSchema,
  runtimeActionableErrorEventSchema,
  mcpToolInvocationEventSchema,
  operatorRuntimeControlEventSchema,
]);

export type LoggedEvent = z.infer<typeof loggedEventSchema>;
type RuntimeDiagnosticEvent = z.infer<typeof runtimeDiagnosticEventSchema>;
export type RuntimeActionableErrorEvent = z.infer<typeof runtimeActionableErrorEventSchema>;
type McpToolInvocationEvent = z.infer<typeof mcpToolInvocationEventSchema>;
export type EventKind = LoggedEvent['kind'];
export type LoggedEventByKind = { [K in EventKind]: Extract<LoggedEvent, { kind: K }> };
type SeverityLevel = 'info' | 'warning' | 'error';

export const eventKindValues = [
  'runtime_diagnostic',
  'runtime_actionable_error',
  'mcp_tool_invocation',
  'operator_runtime_control',
] as const satisfies readonly EventKind[];

const eventSeverity = {
  runtime_diagnostic: 'error',
  runtime_actionable_error: 'error',
  mcp_tool_invocation: 'info',
  operator_runtime_control: 'info',
} as const satisfies Record<EventKind, SeverityLevel>;

export function getEventSeverity(kind: EventKind): SeverityLevel {
  return eventSeverity[kind];
}

export const errorEventSchema = z.union([
  runtimeDiagnosticEventSchema,
  runtimeActionableErrorEventSchema,
  mcpToolInvocationEventSchema.refine(
    (event) => !event.success,
    'Successful MCP invocations are not error events.',
  ),
]);

export type ErrorEvent =
  | RuntimeDiagnosticEvent
  | RuntimeActionableErrorEvent
  | (McpToolInvocationEvent & { success: false });

export function isErrorEvent(event: LoggedEvent): event is ErrorEvent {
  return (
    event.kind === 'runtime_diagnostic' ||
    event.kind === 'runtime_actionable_error' ||
    (event.kind === 'mcp_tool_invocation' && !event.success)
  );
}
