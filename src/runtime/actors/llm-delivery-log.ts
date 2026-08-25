import { agentMessageSchema, canonicalJson, DURABLE_PRIMARY_CONTENT_POLICY, STRUCTURAL_ROW_POLICY, type AgentMessage, type ConversationSessionId, type SettledToolEvidence, type ToolResultPolicyTemplate, type ToolSettlementOrigin } from '../../schemas/index.js';
import { deterministicRoundId } from '../../schemas/round-id-server.js';
import { conversationSha256 } from '../../persistence/canonical-conversation-artifacts.js';
import type { ProviderPrivateContext, ToolCall } from '../../agents/llm-contracts.js';
import type { CanonicalLlmInvocationInput } from './llm-invocation.js';
import { projectSettledToolResultForConversation } from '../../tools/tool-invocation-outbound.js';
import { settlementProviderResult, UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE, type ToolSettlementInput, type ToolResult } from '../../tools/invocation.js';
import { appendConversationBatch, type ConversationFileContext } from '../../persistence/conversation-file.js';
import { validateResponsesPairs } from '../../agents/llm-openai-responses-mapper.js';

export type InvocationResultPolicy = Readonly<{
  resultPolicyTemplate: ToolResultPolicyTemplate;
  resultPolicyTemplateBytes: string;
  resultPolicyTemplateSha256: string;
}>;

const UNSUPPORTED_INVOCATION_RESULT_POLICY: InvocationResultPolicy = Object.freeze({
  resultPolicyTemplate: UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE,
  resultPolicyTemplateBytes: canonicalJson(UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE),
  resultPolicyTemplateSha256: conversationSha256(canonicalJson(UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE)),
});

export function selectInvocationResultPolicy(input: CanonicalLlmInvocationInput, toolName: string): InvocationResultPolicy {
  const contract = input.compiledToolContracts.find((candidate) => candidate.providerDefinition.function.name === toolName);
  return contract ?? UNSUPPORTED_INVOCATION_RESULT_POLICY;
}

function assertResultPolicyConsistency(resultPolicy: InvocationResultPolicy, toolName: string): void {
  const bytes = canonicalJson(resultPolicy.resultPolicyTemplate);
  if (bytes !== resultPolicy.resultPolicyTemplateBytes || conversationSha256(bytes) !== resultPolicy.resultPolicyTemplateSha256)
    throw new Error(`Result policy template for tool '${toolName}' does not commit to its canonical bytes and hash.`);
}

export type SettledToolResultFacts = Readonly<{
  providerResult: ToolResult;
  settledResultBytes: string;
  resultContentSha256: string;
  settlementOrigin: ToolSettlementOrigin;
  evidence: SettledToolEvidence;
  callPolicySha256: string;
}>;

export function settleToolResultForConversation(toolName: string, resultPolicy: InvocationResultPolicy, settlement: ToolSettlementInput): SettledToolResultFacts {
  assertResultPolicyConsistency(resultPolicy, toolName);
  const providerResult = settlementProviderResult(settlement);
  const projected = projectSettledToolResultForConversation(providerResult);
  const settledResultBytes = canonicalJson(projected);
  const resultContentSha256 = conversationSha256(settledResultBytes);
  const settlementOrigin: ToolSettlementOrigin = settlement.kind === 'executed' ? 'executed' : settlement.kind;
  const evidence = settledEvidence(resultPolicy, settlement, projected, toolName);
  return Object.freeze({ providerResult: projected, settledResultBytes, resultContentSha256, settlementOrigin, evidence, callPolicySha256: resultPolicy.resultPolicyTemplateSha256 });
}

function settledEvidence(resultPolicy: InvocationResultPolicy, settlement: ToolSettlementInput, projected: ToolResult, toolName: string): SettledToolEvidence {
  if (settlement.kind !== 'executed') return { kind: 'none' };
  if (!projected.success) return { kind: 'none' };
  const executionEvidence = settlement.execution.evidence;
  switch (resultPolicy.resultPolicyTemplate.evidenceMode) {
    case 'observational_query':
      if (executionEvidence.kind !== 'observational_result_bytes') throw new Error(`Executed observational tool '${toolName}' must supply observational result bytes evidence.`);
      return { kind: 'observational_query', observedSha256: conversationSha256(canonicalJson(projected)) };
    case 'canonical_locator':
      if (executionEvidence.kind !== 'canonical_locator') throw new Error(`Executed canonical-locator tool '${toolName}' must supply its validated locator evidence.`);
      return { kind: 'canonical_locator', locator: executionEvidence.locator, sha256: executionEvidence.sha256 };
    case 'none':
      if (executionEvidence.kind !== 'none') throw new Error(`Executed none-evidence tool '${toolName}' must supply none evidence.`);
      return { kind: 'none' };
  }
}

export function appendLlmTurnStarted(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput): AgentMessage[] {
  const messages: AgentMessage[] = [agentMessageSchema.parse({
    id: `${input.inputId}:started`,
    session_id: input.sessionId,
    role: 'system',
    kind: 'activity',
    content: JSON.stringify({ event: 'llm_turn_started', inputId: input.inputId, agent_name: input.agentName }),
    context_policy: STRUCTURAL_ROW_POLICY.activation_boundary,
    round_id: deterministicRoundId('pre', input.inputId),
    message_index: 0,
    block_index: 0,
    timestamp: new Date().toISOString(),
  })];
  appendConversationBatch(conversations, messages);
  return messages;
}

function appendLlmTurnMessage(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, content: string): AgentMessage {
  const message = buildLlmTurnMessage(input, content);
  appendOne(conversations, message);
  return message;
}

export function buildLlmTurnMessage(input: CanonicalLlmInvocationInput, content: string): AgentMessage {
  return agentMessageSchema.parse({
      id: `${input.inputId}:message`,
      session_id: input.sessionId,
      role: 'assistant',
      kind: 'text',
      content,
      context_policy: DURABLE_PRIMARY_CONTENT_POLICY,
      round_id: deterministicRoundId('assistant', input.inputId),
      message_index: 1,
      block_index: 0,
      timestamp: new Date().toISOString(),
    });
}

function providerPrivateResponsesMessage(input: CanonicalLlmInvocationInput, projectionMessageId: string, privateContext: ProviderPrivateContext): AgentMessage {
  if (privateContext.kind !== 'openai_responses') throw new Error(`Unsupported provider private context kind '${privateContext.kind}'.`);
  if (privateContext.source_input_id !== input.inputId) throw new Error(`Provider private context source_input_id '${privateContext.source_input_id}' does not match input '${input.inputId}'.`);
  return agentMessageSchema.parse({
    id: `${input.inputId}:provider-private:openai-responses`,
    session_id: input.sessionId,
    role: 'system',
    kind: 'provider_private',
    content: JSON.stringify({ transport: 'openai-responses', source_input_id: input.inputId, projection_message_id: projectionMessageId, provider: privateContext.provider, model: privateContext.model, output: privateContext.output }),
    context_policy: STRUCTURAL_ROW_POLICY.responses_private,
    round_id: deterministicRoundId('assistant', `${input.inputId}:provider-private`),
    message_index: 1,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
}

export function appendLlmTurnMessageBatch(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, content: string, privateContext?: ProviderPrivateContext): AgentMessage {
  if (!privateContext) return appendLlmTurnMessage(conversations, input, content);
  const visible = buildLlmTurnMessage(input, content);
  const privateRow = providerPrivateResponsesMessage(input, visible.id, privateContext);
  visible.provider_projection = { kind: 'openai_responses', source_input_id: input.inputId, private_message_id: privateRow.id, projection_kind: 'assistant_message' };
  validateResponsesPairs(input.sessionId, [privateRow, visible]);
  appendVisibleBatch(conversations, [privateRow, visible]);
  return visible;
}

export function appendLlmTurnError(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, error: string): AgentMessage {
  const message = agentMessageSchema.parse({
    id: `${input.inputId}:error`,
    session_id: input.sessionId,
    role: 'assistant',
    kind: 'model_issue',
    content: error,
    context_policy: STRUCTURAL_ROW_POLICY.provider_failure,
    round_id: deterministicRoundId('assistant', input.inputId),
    message_index: 1,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
  appendOne(conversations, message);
  return message;
}

export interface ToolSettlementAppendRecord {
  readonly session_id: ConversationSessionId;
  readonly source_input_id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly resultPolicy: InvocationResultPolicy;
  readonly settlement: ToolSettlementInput;
}

export function appendToolResult(conversations: ConversationFileContext, record: ToolSettlementAppendRecord): SettledToolResultFacts {
  const facts = settleToolResultForConversation(record.tool_name, record.resultPolicy, record.settlement);
  const message = buildToolResultMessage(record, facts, new Date().toISOString());
  appendOne(conversations, message);
  return facts;
}

function toolCallAgentMessage(input: CanonicalLlmInvocationInput, toolCall: ToolCall, resultPolicy: InvocationResultPolicy, index = 0, timestamp = new Date().toISOString()): AgentMessage {
  assertResultPolicyConsistency(resultPolicy, toolCall.function.name);
  return agentMessageSchema.parse({
    id: `${input.inputId}:tool-call:${toolCall.id}`,
    session_id: input.sessionId,
    role: 'assistant',
    kind: 'tool_call',
    content: JSON.stringify(toolCallAgentContent(toolCall)),
    context_policy: { kind: 'tool_call', template: resultPolicy.resultPolicyTemplate, template_bytes: resultPolicy.resultPolicyTemplateBytes, template_sha256: resultPolicy.resultPolicyTemplateSha256 },
    tool: toolCall.function.name,
    tool_call_id: toolCall.id,
    round_id: deterministicRoundId('assistant', input.inputId),
    message_index: 1,
    block_index: index,
    timestamp,
  });
}

export function appendLlmTurnToolCallBatch(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, toolCall: ToolCall, resultPolicy: InvocationResultPolicy, privateContext?: ProviderPrivateContext): AgentMessage {
  if (!privateContext) return appendLlmTurnToolCall(conversations, input, toolCall, resultPolicy);
  const visible = toolCallAgentMessage(input, toolCall, resultPolicy, 0, new Date().toISOString());
  const privateRow = providerPrivateResponsesMessage(input, visible.id, privateContext);
  visible.provider_projection = { kind: 'openai_responses', source_input_id: input.inputId, private_message_id: privateRow.id, projection_kind: 'assistant_tool_call' };
  validateResponsesPairs(input.sessionId, [privateRow, visible]);
  appendVisibleBatch(conversations, [privateRow, visible]);
  return visible;
}

function buildToolResultMessage(record: ToolSettlementAppendRecord, facts: SettledToolResultFacts, createdAt: string): AgentMessage {
  return agentMessageSchema.parse({
    id: `${record.source_input_id}:tool-result:${record.tool_call_id}`,
    session_id: record.session_id,
    role: 'tool',
    kind: 'tool_result',
    content: facts.settledResultBytes,
    context_policy: { kind: 'tool_result', settlement_origin: facts.settlementOrigin, result_content_sha256: facts.resultContentSha256, call_policy_sha256: facts.callPolicySha256, evidence: facts.evidence },
    tool: record.tool_name,
    tool_call_id: record.tool_call_id,
    round_id: deterministicRoundId('user', record.source_input_id),
    message_index: 2,
    block_index: 0,
    timestamp: createdAt,
  });
}

export function appendProviderVisibleSyntheticFailedToolResult(conversations: ConversationFileContext, record: { sessionId: ConversationSessionId; sourceInputId: string; toolCallId: string; toolName: string; error: string; data?: unknown; resultPolicy: InvocationResultPolicy }): void {
  appendToolResult(conversations, {
    session_id: record.sessionId,
    source_input_id: record.sourceInputId,
    tool_call_id: record.toolCallId,
    tool_name: record.toolName,
    resultPolicy: record.resultPolicy,
    settlement: record.data === undefined
      ? { kind: 'execution_failed', providerResult: { success: false, error: record.error } }
      : { kind: 'execution_failed', providerResult: { success: false, error: record.error, data: record.data } },
  });
}

function appendLlmTurnToolCall(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, toolCall: ToolCall, resultPolicy: InvocationResultPolicy): AgentMessage {
  return appendToolCallMessage(conversations, input, toolCall, resultPolicy, 0);
}

function appendToolCallMessage(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, toolCall: ToolCall, resultPolicy: InvocationResultPolicy, index: number): AgentMessage {
  const message = toolCallAgentMessage(input, toolCall, resultPolicy, index);
  appendOne(conversations, message);
  return message;
}

function toolCallAgentContent(toolCall: ToolCall): unknown {
  return {
    role: 'assistant',
    tool_calls: [
      {
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      },
    ],
  };
}

export function appendModelRepairMessage(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, content: string): AgentMessage {
  const message = agentMessageSchema.parse({
    id: `${input.inputId}:repair`,
    session_id: input.sessionId,
    role: 'user',
    kind: 'model_repair',
    content,
    context_policy: DURABLE_PRIMARY_CONTENT_POLICY,
    round_id: deterministicRoundId('user', input.inputId),
    message_index: 3,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
  appendOne(conversations, message);
  return message;
}

function appendOne(conversations: ConversationFileContext, message: AgentMessage): void {
  appendConversationBatch(conversations, [message]);
}

function appendVisibleBatch(conversations: ConversationFileContext, messages: AgentMessage[]): void {
  appendConversationBatch(conversations, messages);
}
