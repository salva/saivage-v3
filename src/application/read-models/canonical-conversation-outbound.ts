import { parseToolCallMessageForModel } from '../../contracts/persisted-tool-call.js';
import {
  ToolInvocationResultSchema,
  type CanonicalCallIdentity,
  type CanonicalResultIdentity,
  type ToolInvocationProjectionInput,
  type ToolInvocationProjector,
} from '../../contracts/tool-invocation-projection.js';
import { agentMessageSchema, type AgentMessage } from '../../schemas/index.js';
import {
  sourceInputIdFromToolCallMessageId,
  sourceInputIdFromToolResultMessageId,
} from '../../schemas/message-identity.js';
import { redactTextForOutbound } from '../../redaction/text.js';

export function projectCanonicalConversationRow(
  value: unknown,
  projectInvocation: ToolInvocationProjector,
): AgentMessage {
  const row = stripModelDecoration(agentMessageSchema.parse(value));
  if (row.kind === 'tool_call') return projectCallRow(row, projectInvocation);
  if (row.kind === 'tool_result') return projectResultRow(row, projectInvocation);
  return agentMessageSchema.parse({
    ...row,
    content: redactTextForOutbound(row.content),
    ...(row.links
      ? {
          links: row.links.map((link) => ({
            ...link,
            ...(link.label === undefined ? {} : { label: redactTextForOutbound(link.label) }),
          })),
        }
      : {}),
  });
}

function stripModelDecoration(row: AgentMessage): AgentMessage {
  const projected = { ...row };
  delete projected.model_spec;
  delete projected.requested_model_spec;
  return agentMessageSchema.parse(projected);
}

function projectCallRow(
  row: AgentMessage,
  projectInvocation: ToolInvocationProjector,
): AgentMessage {
  if (row.role !== 'assistant' || !row.tool || !row.tool_call_id)
    throw new Error(`Tool call '${row.id}' is missing canonical identity metadata.`);
  let embedded: ReturnType<typeof parseToolCallMessageForModel>;
  try {
    embedded = parseToolCallMessageForModel(JSON.parse(row.content));
  } catch (error) {
    throw new Error(`Tool call '${row.id}' has malformed embedded content: ${errorMessage(error)}`);
  }
  if (embedded.id !== row.tool_call_id || embedded.name !== row.tool)
    throw new Error(`Tool call '${row.id}' embedded identity does not match row metadata.`);
  const identity: CanonicalCallIdentity = {
    sessionId: row.session_id,
    sourceInputId: sourceInputIdFromToolCallMessageId(row.id, row.tool_call_id),
    toolCallId: row.tool_call_id,
    toolName: row.tool,
    startedAt: row.timestamp,
  };
  const projected = projectInvocation({
    shape: 'call-row',
    identity,
    arguments: embedded.arguments,
  });
  assertProjectedCall(projected, identity);
  return agentMessageSchema.parse({
    ...row,
    content: JSON.stringify({
      role: 'assistant',
      tool_calls: [
        {
          id: identity.toolCallId,
          type: 'function',
          function: { name: identity.toolName, arguments: projected.arguments },
        },
      ],
    }),
  });
}

function projectResultRow(
  row: AgentMessage,
  projectInvocation: ToolInvocationProjector,
): AgentMessage {
  if (row.role !== 'tool' || !row.tool || !row.tool_call_id)
    throw new Error(`Tool result '${row.id}' is missing canonical identity metadata.`);
  let result: ReturnType<typeof ToolInvocationResultSchema.parse>;
  try {
    result = ToolInvocationResultSchema.parse(JSON.parse(row.content));
  } catch (error) {
    throw new Error(`Tool result '${row.id}' has malformed content: ${errorMessage(error)}`);
  }
  const identity: CanonicalResultIdentity = {
    sessionId: row.session_id,
    sourceInputId: sourceInputIdFromToolResultMessageId(row.id, row.tool_call_id),
    toolCallId: row.tool_call_id,
    toolName: row.tool,
  };
  const projected = projectInvocation({ shape: 'result-row', identity, result });
  assertProjectedResult(projected, identity);
  return agentMessageSchema.parse({ ...row, content: JSON.stringify(projected.result) });
}

function assertProjectedCall(
  projected: ToolInvocationProjectionInput,
  identity: CanonicalCallIdentity,
): asserts projected is Extract<ToolInvocationProjectionInput, { shape: 'call-row' }> {
  if (
    projected.shape !== 'call-row' ||
    Object.hasOwn(projected, 'result') ||
    !sameInvocationIdentity(projected.identity, identity) ||
    projected.identity.startedAt !== identity.startedAt ||
    typeof projected.arguments !== 'string'
  )
    throw new Error('Invocation projector changed canonical call-row shape or identity.');
}
function assertProjectedResult(
  projected: ToolInvocationProjectionInput,
  identity: CanonicalResultIdentity,
): asserts projected is Extract<ToolInvocationProjectionInput, { shape: 'result-row' }> {
  if (
    projected.shape !== 'result-row' ||
    Object.hasOwn(projected, 'arguments') ||
    !sameInvocationIdentity(projected.identity, identity)
  )
    throw new Error('Invocation projector changed canonical result-row shape or identity.');
  ToolInvocationResultSchema.parse(projected.result);
}
function sameInvocationIdentity(
  left: CanonicalResultIdentity,
  right: CanonicalResultIdentity,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sourceInputId === right.sourceInputId &&
    left.toolCallId === right.toolCallId &&
    left.toolName === right.toolName
  );
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
