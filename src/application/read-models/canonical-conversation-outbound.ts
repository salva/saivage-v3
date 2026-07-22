import { z } from 'zod';

import {
  AgentActivityStatusSchema,
  AgentSessionSummarySchema,
  type AgentActivityStatus,
  type AgentSessionSummary,
} from '../../contracts/operator-api-agents.js';
import { parseToolCallMessageForModel } from '../../contracts/persisted-tool-call.js';
import {
  ToolInvocationResultSchema,
  type CanonicalCallIdentity,
  type CanonicalResultIdentity,
  type ToolInvocationProjectionInput,
  type ToolInvocationProjector,
} from '../../contracts/tool-invocation-projection.js';
import {
  agentMessageSchema,
  ConversationSessionIdSchema,
  type AgentMessage,
  type ConversationSessionId,
} from '../../schemas/index.js';
import {
  loggedToolCallKey,
  sourceInputIdFromToolCallMessageId,
  sourceInputIdFromToolResultMessageId,
} from '../../schemas/message-identity.js';
import { redactTextForOutbound } from '../../redaction/text.js';

export type ExactResultAbsentDeclaration =
  | ({ readonly state: 'active-in-flight' } & CanonicalCallIdentity)
  | ({ readonly state: 'waiting' } & CanonicalCallIdentity);

export interface BoundedAgentSessionWrapper {
  readonly session: AgentSessionSummary;
  readonly activity_status: AgentActivityStatus;
  readonly total_messages: number;
  readonly returned: number;
  readonly parse_errors: 0;
  readonly messages: readonly AgentMessage[];
}

const exactResultAbsentDeclarationSchema = z.discriminatedUnion('state', [
  exactDeclarationVariant('active-in-flight'),
  exactDeclarationVariant('waiting'),
]);

const boundedAgentSessionWrapperSchema = z.object({
  session: AgentSessionSummarySchema,
  activity_status: AgentActivityStatusSchema,
  total_messages: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  parse_errors: z.literal(0),
  messages: z.array(agentMessageSchema),
}).strict().superRefine((value, ctx) => {
  if (value.session.status !== value.activity_status.status) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activity_status', 'status'], message: 'Session and activity status must match.' });
  }
  if (value.returned !== value.messages.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['returned'], message: 'Returned count must equal the selected message count.' });
  }
  if (value.total_messages < value.returned) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['total_messages'], message: 'Total message count cannot be smaller than the returned count.' });
  }
  for (const [index, message] of value.messages.entries()) {
    if (message.session_id !== value.session.id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['messages', index, 'session_id'], message: 'Selected message session must match the enclosing session.' });
    }
  }
});

interface InspectedCall {
  readonly identity: CanonicalCallIdentity;
  readonly arguments: string;
}

export interface CanonicalResultAbsentCall extends CanonicalCallIdentity {
  readonly arguments: string;
}

interface InspectedResult {
  readonly identity: CanonicalResultIdentity;
  readonly result: ReturnType<typeof ToolInvocationResultSchema.parse>;
}

interface SelectedPairInspection {
  readonly calls: Map<string, InspectedCall>;
  readonly results: Map<string, InspectedResult>;
}

export function projectCanonicalConversationRow(
  value: unknown,
  projectInvocation: ToolInvocationProjector,
): AgentMessage {
  const row = agentMessageSchema.parse(value);
  if (row.kind === 'tool_call') return projectCallRow(row, projectInvocation);
  if (row.kind === 'tool_result') return projectResultRow(row, projectInvocation);

  return agentMessageSchema.parse({
    ...row,
    content: redactTextForOutbound(row.content),
    ...(row.links
      ? { links: row.links.map((link) => ({
          ...link,
          ...(link.label === undefined ? {} : { label: redactTextForOutbound(link.label) }),
        })) }
      : {}),
  });
}

export function projectCompleteCanonicalConversation(
  values: readonly unknown[],
  declaration: ExactResultAbsentDeclaration | undefined,
  projectInvocation: ToolInvocationProjector,
): AgentMessage[] {
  const rows = values.map((value) => agentMessageSchema.parse(value));
  const inspection = inspectSelectedRows(rows, false);
  const unmatched = [...inspection.calls.entries()].filter(([key]) => !inspection.results.has(key));
  if (unmatched.length > 1) throw new Error('Complete conversation contains more than one result-absent tool call.');

  if (declaration === undefined) {
    if (unmatched.length !== 0) throw new Error('Complete conversation contains an undeclared result-absent tool call.');
  } else {
    const parsedDeclaration = exactResultAbsentDeclarationSchema.parse(declaration);
    if (unmatched.length !== 1) throw new Error('Result-absent declaration must identify the sole unmatched tool call.');
    const call = unmatched[0]![1];
    if (!sameCallIdentity(call.identity, parsedDeclaration)) {
      throw new Error('Result-absent declaration does not match the sole unmatched tool call.');
    }
  }

  return rows.map((row) => projectCanonicalConversationRow(row, projectInvocation));
}

export function inspectCompleteCanonicalConversation(values: readonly unknown[]): CanonicalResultAbsentCall | undefined {
  const rows = values.map((value) => agentMessageSchema.parse(value));
  const inspection = inspectSelectedRows(rows, false);
  const unmatched = [...inspection.calls.entries()].filter(([key]) => !inspection.results.has(key));
  if (unmatched.length > 1) throw new Error('Complete conversation contains more than one result-absent tool call.');
  const call = unmatched[0]?.[1];
  return call ? { ...call.identity, arguments: call.arguments } : undefined;
}

export function projectBoundedAgentSessionWrapper(
  value: unknown,
  projectInvocation: ToolInvocationProjector,
): BoundedAgentSessionWrapper {
  const wrapper = boundedAgentSessionWrapperSchema.parse(value);
  const inspection = inspectSelectedRows(wrapper.messages, true);
  const callOnly = [...inspection.calls.entries()].filter(([key]) => !inspection.results.has(key)).map(([, call]) => call);

  switch (wrapper.activity_status.status) {
    case 'inactive':
      if (callOnly.length !== 0) throw new Error('Inactive bounded session cannot contain a result-absent tool call.');
      break;
    case 'active':
      if (callOnly.length > 1) throw new Error('Active bounded session cannot contain more than one result-absent tool call.');
      break;
    case 'waiting': {
      if (callOnly.length !== 1) throw new Error('Waiting bounded session requires exactly one selected result-absent tool call.');
      const pending = wrapper.activity_status.pending_calls[0]!;
      const call = callOnly[0]!.identity;
      if (pending.id !== call.toolCallId || pending.tool !== call.toolName || pending.started_at !== call.startedAt) {
        throw new Error('Waiting bounded session pending call does not match the selected result-absent tool call.');
      }
      break;
    }
    default:
      assertNever(wrapper.activity_status.status);
  }

  const messages = wrapper.messages.map((row) => projectCanonicalConversationRow(row, projectInvocation));
  return boundedAgentSessionWrapperSchema.parse({ ...wrapper, messages });
}

function projectCallRow(row: AgentMessage, projectInvocation: ToolInvocationProjector): AgentMessage {
  const inspected = inspectCall(row);
  const projected = projectInvocation({ shape: 'call-row', identity: inspected.identity, arguments: inspected.arguments });
  assertProjectedCall(projected, inspected.identity);
  return agentMessageSchema.parse({
    ...row,
    content: JSON.stringify({
      role: 'assistant',
      tool_calls: [{
        id: inspected.identity.toolCallId,
        type: 'function',
        function: { name: inspected.identity.toolName, arguments: projected.arguments },
      }],
    }),
  });
}

function projectResultRow(row: AgentMessage, projectInvocation: ToolInvocationProjector): AgentMessage {
  const inspected = inspectResult(row);
  const projected = projectInvocation({ shape: 'result-row', identity: inspected.identity, result: inspected.result });
  assertProjectedResult(projected, inspected.identity);
  return agentMessageSchema.parse({ ...row, content: JSON.stringify(projected.result) });
}

function inspectSelectedRows(rows: readonly AgentMessage[], allowIsolatedResults: boolean): SelectedPairInspection {
  const calls = new Map<string, InspectedCall>();
  const results = new Map<string, InspectedResult>();
  for (const row of rows) {
    if (row.kind === 'tool_call') {
      const call = inspectCall(row);
      const key = identityKey(call.identity);
      if (calls.has(key)) throw new Error(`Duplicate tool call identity '${key}'.`);
      if (results.has(key)) throw new Error(`Tool result for '${key}' precedes its selected call.`);
      calls.set(key, call);
      continue;
    }
    if (row.kind !== 'tool_result') continue;
    const result = inspectResult(row);
    const key = identityKey(result.identity);
    if (results.has(key)) throw new Error(`Tool call identity '${key}' has duplicate settlements.`);
    const call = calls.get(key);
    if (!call && !allowIsolatedResults) throw new Error(`Tool settlement '${row.id}' has no prior matching call.`);
    if (call && call.identity.toolName !== result.identity.toolName) throw new Error(`Tool call identity '${key}' has mismatched call/result tool names.`);
    results.set(key, result);
  }
  return { calls, results };
}

function inspectCall(row: AgentMessage): InspectedCall {
  if (row.role !== 'assistant') throw new Error(`Tool call '${row.id}' must use assistant role.`);
  if (!row.tool || !row.tool_call_id) throw new Error(`Validated tool_call message '${row.id}' is missing canonical identity metadata.`);
  let embedded: ReturnType<typeof parseToolCallMessageForModel>;
  try { embedded = parseToolCallMessageForModel(JSON.parse(row.content)); }
  catch (error) { throw new Error(`Tool call '${row.id}' has malformed embedded content: ${errorMessage(error)}`); }
  if (embedded.id !== row.tool_call_id || embedded.name !== row.tool) throw new Error(`Tool call '${row.id}' embedded identity does not match row metadata.`);
  return {
    arguments: embedded.arguments,
    identity: {
      sessionId: row.session_id,
      sourceInputId: sourceInputIdFromToolCallMessageId(row.id, row.tool_call_id),
      toolCallId: row.tool_call_id,
      toolName: row.tool,
      startedAt: row.timestamp,
    },
  };
}

function inspectResult(row: AgentMessage): InspectedResult {
  if (row.role !== 'tool') throw new Error(`Tool result '${row.id}' must use tool role.`);
  if (!row.tool || !row.tool_call_id) throw new Error(`Validated tool_result message '${row.id}' is missing canonical identity metadata.`);
  let result: ReturnType<typeof ToolInvocationResultSchema.parse>;
  try { result = ToolInvocationResultSchema.parse(JSON.parse(row.content)); }
  catch (error) { throw new Error(`Tool result '${row.id}' has malformed content: ${errorMessage(error)}`); }
  return {
    result,
    identity: {
      sessionId: row.session_id,
      sourceInputId: sourceInputIdFromToolResultMessageId(row.id, row.tool_call_id),
      toolCallId: row.tool_call_id,
      toolName: row.tool,
    },
  };
}

function assertProjectedCall(projected: ToolInvocationProjectionInput, identity: CanonicalCallIdentity): asserts projected is Extract<ToolInvocationProjectionInput, { shape: 'call-row' }> {
  if (projected.shape !== 'call-row') throw new Error('Invocation projector changed a call-row projection shape.');
  if (Object.hasOwn(projected, 'result')) throw new Error('Invocation projector invented a result for a call-row projection.');
  if (!sameCallIdentity(projected.identity, identity)) throw new Error('Invocation projector changed canonical call-row identity.');
  if (typeof projected.arguments !== 'string') throw new Error('Invocation projector returned non-string canonical call arguments.');
}

function assertProjectedResult(projected: ToolInvocationProjectionInput, identity: CanonicalResultIdentity): asserts projected is Extract<ToolInvocationProjectionInput, { shape: 'result-row' }> {
  if (projected.shape !== 'result-row') throw new Error('Invocation projector changed a result-row projection shape.');
  if (Object.hasOwn(projected, 'arguments')) throw new Error('Invocation projector invented arguments for a result-row projection.');
  if (!sameInvocationIdentity(projected.identity, identity)) throw new Error('Invocation projector changed canonical result-row identity.');
  ToolInvocationResultSchema.parse(projected.result);
}

function sameCallIdentity(left: CanonicalCallIdentity, right: CanonicalCallIdentity): boolean {
  return sameInvocationIdentity(left, right) && left.startedAt === right.startedAt;
}

function sameInvocationIdentity(left: CanonicalResultIdentity, right: CanonicalResultIdentity): boolean {
  return left.sessionId === right.sessionId
    && left.sourceInputId === right.sourceInputId
    && left.toolCallId === right.toolCallId
    && left.toolName === right.toolName;
}

function identityKey(identity: CanonicalResultIdentity): string {
  return loggedToolCallKey({
    session_id: identity.sessionId,
    source_input_id: identity.sourceInputId,
    tool_call_id: identity.toolCallId,
  });
}

function exactDeclarationVariant<State extends ExactResultAbsentDeclaration['state']>(state: State) {
  return z.object({
    state: z.literal(state),
    sessionId: ConversationSessionIdSchema,
    sourceInputId: z.string().uuid(),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    startedAt: z.string().datetime(),
  }).strict();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled bounded activity status '${String(value)}'.`);
}
