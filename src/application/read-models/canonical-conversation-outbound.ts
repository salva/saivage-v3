import { sha256Hex } from '../../schemas/index.js';

import {
  parseToolCallMessageForModel,
  ToolResultSchema,
  type CanonicalCallIdentity,
  type CanonicalResultIdentity,
  type ToolInvocationProjectionInput,
  type ToolInvocationProjector,
} from '../../contracts/index.js';
import {
  agentMessageSchema,
  canonicalJson,
  parseCanonicalContentPolicyRefusal,
  parseActivationOpenPayload,
  type AgentMessage,
} from '../../schemas/index.js';
import {
  sourceInputIdFromToolCallMessageId,
  sourceInputIdFromToolResultMessageId,
} from '../../schemas/index.js';
import { redactTextForOutbound } from '../../redaction/index.js';
import { publicRecordSelection, type RecordObservation } from '../../schemas/index.js';
import {
  AgentConversationEntrySchema,
  type AgentConversationEntry,
} from '../../contracts/index.js';

export function projectRecordObservation(value: RecordObservation) {
  const source = value.source;
  const observed = publicRecordSelection(value.observed);
  const accepted = (selection: Extract<typeof observed.selection, { kind: 'accepted' }>) => ({
    ...selection,
    locator: redactTextForOutbound(selection.locator),
  });
  return {
    observed: {
      ...observed,
      record_name: redactTextForOutbound(observed.record_name),
      selection:
        observed.selection.kind === 'accepted'
          ? accepted(observed.selection)
          : observed.selection.kind === 'draft'
            ? {
                kind: 'draft' as const,
                accepted_backing: observed.selection.accepted_backing
                  ? accepted(observed.selection.accepted_backing)
                  : null,
              }
            : observed.selection,
    },
    source:
      source.kind === 'preparation'
        ? {
            kind: source.kind,
            input_id: source.input_id,
            node_id: redactTextForOutbound(source.node_id),
          }
        : source.kind === 'prompt'
          ? {
              kind: source.kind,
              input_id: source.input_id,
              node_id: redactTextForOutbound(source.node_id),
              reference: redactTextForOutbound(source.reference),
            }
          : {
              kind: source.kind,
              input_id: source.input_id,
              tool_call_id: redactTextForOutbound(source.tool_call_id),
              tool_name: redactTextForOutbound(source.tool_name),
            },
  };
}

export function projectCanonicalConversationRow(
  value: unknown,
  projectInvocation: ToolInvocationProjector,
): AgentConversationEntry {
  const row = projectRow(value, projectInvocation);
  const policy = row.context_policy;
  return AgentConversationEntrySchema.parse({
    ...row,
    id: redactTextForOutbound(row.id),
    ...(row.tool ? { tool: redactTextForOutbound(row.tool) } : {}),
    ...(row.tool_call_id ? { tool_call_id: redactTextForOutbound(row.tool_call_id) } : {}),
    context_policy:
      policy.kind === 'content'
        ? {
            kind: policy.kind,
            compactable: policy.compactable,
            ...(policy.compaction_key === undefined
              ? {}
              : { compaction_key: redactTextForOutbound(policy.compaction_key) }),
          }
        : policy.kind === 'structural'
          ? { kind: policy.kind, behavior: policy.behavior }
          : policy.kind === 'tool_result'
            ? { kind: policy.kind, settlement_origin: policy.settlement_origin }
            : { kind: policy.kind },
    ...(row.record_observations
      ? { record_observations: row.record_observations.map(projectRecordObservation) }
      : {}),
    ...(row.record_prompt
      ? {
          record_prompt: {
            ...row.record_prompt,
            node_id: redactTextForOutbound(row.record_prompt.node_id),
            reference: redactTextForOutbound(row.record_prompt.reference),
          },
        }
      : {}),
  });
}

function projectRow(value: unknown, projectInvocation: ToolInvocationProjector): AgentMessage {
  const row = stripModelDecoration(agentMessageSchema.parse(value));
  if (row.kind === 'activity') {
    const payload = parseActivationOpenPayload(row.content, row.session_id, row.timestamp);
    if (payload) {
      const instructions = payload.instructions;
      return agentMessageSchema.parse({
        ...row,
        ...(row.links
          ? {
              links: row.links.map((link) => ({
                ...link,
                ...(link.label === undefined ? {} : { label: redactTextForOutbound(link.label) }),
              })),
            }
          : {}),
        content: canonicalJson({
          event: 'activation_open',
          agent_name: payload.agent_name,
          ...('card_id' in payload ? { card_id: payload.card_id } : {}),
          input_id: payload.input_id,
          timestamp: payload.timestamp,
          instructions:
            instructions.kind === 'prepared'
              ? {
                  kind: 'prepared',
                  role_text: redactTextForOutbound(instructions.role_text),
                  activation_id: instructions.activation_id,
                  caller:
                    instructions.caller.kind === 'parent'
                      ? {
                          kind: 'parent',
                          cardId: instructions.caller.cardId,
                          sessionId: instructions.caller.sessionId,
                          sourceInputId: instructions.caller.sourceInputId,
                          toolCallId: redactTextForOutbound(instructions.caller.toolCallId),
                          toolName: instructions.caller.toolName,
                        }
                      : { kind: instructions.caller.kind },
                  card:
                    instructions.card === null
                      ? null
                      : {
                          cardId: instructions.card.cardId,
                          cardType: instructions.card.cardType,
                          title: redactTextForOutbound(instructions.card.title),
                        },
                  parent_direction:
                    instructions.parent_direction === null
                      ? null
                      : {
                          text: redactTextForOutbound(instructions.parent_direction.text),
                        },
                  node:
                    instructions.node === null
                      ? null
                      : {
                          node_id: instructions.node.node_id,
                          text: redactTextForOutbound(instructions.node.text),
                        },
                }
              : { kind: instructions.kind, reason: instructions.reason },
        }),
      });
    }
  }
  if (row.kind === 'tool_call') return projectCallRow(row, projectInvocation);
  if (row.kind === 'tool_result') return projectResultRow(row, projectInvocation);
  if (row.kind === 'content_policy_refusal') {
    const payload = parseCanonicalContentPolicyRefusal(row.content);
    return agentMessageSchema.parse({
      ...row,
      content: canonicalJson({
        ...payload,
        provider_response: redactTextForOutbound(payload.provider_response),
      }),
    });
  }
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
          id: redactTextForOutbound(identity.toolCallId),
          type: 'function',
          function: {
            name: redactTextForOutbound(identity.toolName),
            arguments: projected.arguments,
          },
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
  let result: ReturnType<typeof ToolResultSchema.parse>;
  try {
    result = ToolResultSchema.parse(JSON.parse(row.content));
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
  const content = JSON.stringify(projected.result);
  if (row.context_policy.kind !== 'tool_result')
    throw new Error(`Tool result '${row.id}' is missing its tool_result context policy.`);
  return agentMessageSchema.parse({
    ...row,
    content,
    context_policy: { ...row.context_policy, result_content_sha256: sha256Hex(content) },
  });
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
  ToolResultSchema.parse(projected.result);
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
