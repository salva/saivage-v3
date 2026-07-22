import { z } from 'zod';

import { actionableErrorEnvelopeSchema } from './actionable-error.js';
import { cardIdSchema } from './card-id.js';

const eventBaseShape = {
  id: z.string().min(1),
  timestamp: z.string().datetime(),
};

export const runtimeDiagnosticEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('runtime_diagnostic'),
  goal_id: cardIdSchema.optional(),
  card_id: cardIdSchema.optional(),
  phase: z.string().optional(),
  error_message: z.string(),
}).strict();

export const runtimeActionableErrorEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('runtime_actionable_error'),
  actionable_error: actionableErrorEnvelopeSchema,
}).strict();

export const mcpToolInvocationEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('mcp_tool_invocation'),
  server: z.string(),
  tool: z.string(),
  success: z.boolean(),
  duration_ms: z.number().nonnegative(),
  error: z.string().optional(),
}).strict();

export const loggedEventSchema = z.discriminatedUnion('kind', [
  runtimeDiagnosticEventSchema,
  runtimeActionableErrorEventSchema,
  mcpToolInvocationEventSchema,
]);

export type LoggedEvent = z.infer<typeof loggedEventSchema>;
export type RuntimeDiagnosticEvent = z.infer<typeof runtimeDiagnosticEventSchema>;
export type RuntimeActionableErrorEvent = z.infer<typeof runtimeActionableErrorEventSchema>;
export type McpToolInvocationEvent = z.infer<typeof mcpToolInvocationEventSchema>;
export type EventKind = LoggedEvent['kind'];
export type BaseEvent = Pick<LoggedEvent, 'id' | 'kind' | 'timestamp'>;
export type LoggedEventByKind = { [K in EventKind]: Extract<LoggedEvent, { kind: K }> };
export type EventPayloadByKind = { [K in EventKind]: Omit<LoggedEventByKind[K], 'id' | 'kind' | 'timestamp'> };
export type EventPayload<K extends EventKind> = EventPayloadByKind[K];
export type SeverityLevel = 'info' | 'warning' | 'error';

export const eventKindValues = [
  'runtime_diagnostic',
  'runtime_actionable_error',
  'mcp_tool_invocation',
] as const satisfies readonly EventKind[];

export const runtimeEventKindValues = [
  'runtime_diagnostic',
  'runtime_actionable_error',
] as const satisfies readonly EventKind[];

export const agentEventKindValues = ['mcp_tool_invocation'] as const satisfies readonly EventKind[];

const eventSeverity = {
  runtime_diagnostic: 'error',
  runtime_actionable_error: 'error',
  mcp_tool_invocation: 'info',
} as const satisfies Record<EventKind, SeverityLevel>;

export function getEventSeverity(kind: EventKind): SeverityLevel {
  return eventSeverity[kind];
}

export const errorEventSchema = z.union([
  runtimeDiagnosticEventSchema,
  runtimeActionableErrorEventSchema,
  mcpToolInvocationEventSchema.refine((event) => !event.success, 'Successful MCP invocations are not error events.'),
]);

export type ErrorEvent = RuntimeDiagnosticEvent | RuntimeActionableErrorEvent | (McpToolInvocationEvent & { success: false });

export function isErrorEvent(event: LoggedEvent): event is ErrorEvent {
  return event.kind !== 'mcp_tool_invocation' || !event.success;
}

export const loggedEventSchemaByKind = {
  runtime_diagnostic: runtimeDiagnosticEventSchema,
  runtime_actionable_error: runtimeActionableErrorEventSchema,
  mcp_tool_invocation: mcpToolInvocationEventSchema,
} as const satisfies Record<EventKind, z.ZodTypeAny>;

export function buildLoggedEventSchema<K extends EventKind>(kind: K): (typeof loggedEventSchemaByKind)[K] {
  return loggedEventSchemaByKind[kind];
}
