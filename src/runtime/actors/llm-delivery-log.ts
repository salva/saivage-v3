import { createHash } from 'node:crypto';
import { agentMessageSchema, canonicalJson, type SettledToolEvidence } from '../../schemas/index.js';
import type { AgentMessage, ConversationSessionId } from '../../schemas/index.js';
import { deterministicRoundId } from '../../schemas/round-id-server.js';
import type { ProviderPrivateContext, ToolCall } from '../../agents/llm-contracts.js';
import type { CanonicalLlmInvocationInput } from './llm-invocation.js';
import { appendConversationBatch, type ConversationFileContext } from '../../persistence/conversation-file.js';
import { validateResponsesPairs } from '../../agents/llm-openai-responses-mapper.js';
import { durableContentPolicy, structuralContextPolicy } from './context/index.js';
import { compileInvocationToolContract, UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE } from './llm-invocation.js';
import type { ToolResult, ToolSettlementInput, ToolSettlementOrigin } from '../../tools/invocation.js';
import { ToolInvocationResultSchema } from '../../contracts/tool-invocation-projection.js';
interface ToolSettlementRecord {
  session_id: ConversationSessionId;
  source_input_id: string;
  tool_call_id: string;
  tool_name: string;
  settlement: ToolSettlementInput;
  call_policy_sha256: string;
  created_at: string;
}

export type SettledToolResult = Readonly<{ providerResult: ToolResult; settledResultBytes: string; resultContentSha256: string; evidence: SettledToolEvidence; settlementOrigin: ToolSettlementOrigin }>;

export function appendLlmTurnStarted(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput): AgentMessage[] {
  const messages: AgentMessage[] = [agentMessageSchema.parse({
    id: `${input.inputId}:started`,
    session_id: input.sessionId,
    role: 'system',
    kind: 'activity',
    content: JSON.stringify({ event: 'llm_turn_started', inputId: input.inputId, agent_name: input.agentName }),
    context_policy: structuralContextPolicy('activation_boundary'),
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

export function buildLlmTurnMessage(input: CanonicalLlmInvocationInput, content: string, timestamp = new Date().toISOString()): AgentMessage {
  return agentMessageSchema.parse({
      id: `${input.inputId}:message`,
      session_id: input.sessionId,
      role: 'assistant',
      kind: 'text',
      content,
      context_policy: durableContentPolicy(),
      round_id: deterministicRoundId('assistant', input.inputId),
      message_index: 1,
      block_index: 0,
      timestamp,
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
    context_policy: structuralContextPolicy('responses_private'),
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
    context_policy: structuralContextPolicy('provider_failure'),
    round_id: deterministicRoundId('assistant', input.inputId),
    message_index: 1,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
  appendOne(conversations, message);
  return message;
}

export function appendToolResult(conversations: ConversationFileContext, record: Omit<ToolSettlementRecord, 'created_at'>): SettledToolResult {
  const settlementPolicySha256 = sha256(canonicalJson(record.settlement.resultPolicyTemplate));
  if (settlementPolicySha256 !== record.call_policy_sha256) throw new Error('Tool settlement policy does not match the call-owned policy commitment.');
  const parsed: ToolSettlementRecord = { ...record, created_at: new Date().toISOString() };
  const settled = settleToolResult(parsed.settlement);
  const message = buildToolResultMessage({ ...parsed, settled });
  appendOne(conversations, message);
  return settled;
}

function toolCallAgentMessage(input: CanonicalLlmInvocationInput, toolCall: ToolCall, index = 0, timestamp = new Date().toISOString()): AgentMessage {
  const compiled = input.compiledTools.find((tool) => tool.providerDefinition.function.name === toolCall.function.name);
  const policy = compiled ?? compileInvocationToolContract({ type: 'function', function: { name: toolCall.function.name, description: 'Unsupported provider-emitted tool.', parameters: { type: 'object', additionalProperties: true } } }, UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE);
  return agentMessageSchema.parse({
    id: `${input.inputId}:tool-call:${toolCall.id}`,
    session_id: input.sessionId,
    role: 'assistant',
    kind: 'tool_call',
    content: JSON.stringify(toolCallAgentContent(toolCall)),
    context_policy: { kind: 'tool_call', template: policy.resultPolicyTemplate, template_bytes: policy.resultPolicyTemplateBytes, template_sha256: policy.resultPolicyTemplateSha256 },
    tool: toolCall.function.name,
    tool_call_id: toolCall.id,
    round_id: deterministicRoundId('assistant', input.inputId),
    message_index: 1,
    block_index: index,
    timestamp,
  });
}

export function appendLlmTurnToolCallBatch(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, toolCall: ToolCall, privateContext?: ProviderPrivateContext): AgentMessage {
  if (!privateContext) return appendLlmTurnToolCall(conversations, input, toolCall);
  const visible = toolCallAgentMessage(input, toolCall, 0, new Date().toISOString());
  const privateRow = providerPrivateResponsesMessage(input, visible.id, privateContext);
  visible.provider_projection = { kind: 'openai_responses', source_input_id: input.inputId, private_message_id: privateRow.id, projection_kind: 'assistant_tool_call' };
  validateResponsesPairs(input.sessionId, [privateRow, visible]);
  appendVisibleBatch(conversations, [privateRow, visible]);
  return visible;
}

export function buildToolResultMessage(record: Omit<ToolSettlementRecord, 'created_at'> & { created_at?: string; settled?: SettledToolResult }): AgentMessage {
  const complete = { ...record, created_at: record.created_at ?? new Date().toISOString() };
  const settled = record.settled ?? settleToolResult(record.settlement);
  return agentMessageSchema.parse({
    id: `${complete.source_input_id}:tool-result:${complete.tool_call_id}`,
    session_id: complete.session_id,
    role: 'tool',
    kind: 'tool_result',
    content: settled.settledResultBytes,
    context_policy: { kind: 'tool_result', settlement_origin: settled.settlementOrigin, result_content_sha256: settled.resultContentSha256, call_policy_sha256: complete.call_policy_sha256, evidence: settled.evidence },
    tool: complete.tool_name,
    tool_call_id: complete.tool_call_id,
    round_id: deterministicRoundId('user', complete.source_input_id),
    message_index: 2,
    block_index: 0,
    timestamp: complete.created_at,
  });
}

export function appendProviderVisibleSyntheticFailedToolResult(conversations: ConversationFileContext, record: { sessionId: ConversationSessionId; sourceInputId: string; toolCallId: string; toolName: string; settlement: Extract<ToolSettlementInput, { kind: 'synthetic' }>; callPolicySha256: string }): SettledToolResult {
  return appendToolResult(conversations, { session_id: record.sessionId, source_input_id: record.sourceInputId, tool_call_id: record.toolCallId, tool_name: record.toolName, settlement: record.settlement, call_policy_sha256: record.callPolicySha256 });
}

function appendLlmTurnToolCall(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, toolCall: ToolCall): AgentMessage {
  return appendToolCallMessage(conversations, input, toolCall, 0);
}

function appendToolCallMessage(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, toolCall: ToolCall, index: number): AgentMessage {
  const message = toolCallAgentMessage(input, toolCall, index);
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
    context_policy: durableContentPolicy(),
    round_id: deterministicRoundId('user', input.inputId),
    message_index: 3,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
  appendOne(conversations, message);
  return message;
}

export function settleToolResult(settlement: ToolSettlementInput): SettledToolResult {
  const providerResult = ToolInvocationResultSchema.parse(settlement.kind === 'executed' ? settlement.execution.providerResult : settlement.providerResult) as ToolResult;
  const settledResultBytes = canonicalJson(providerResult);
  const resultContentSha256 = sha256(settledResultBytes);
  const evidence = settledEvidence(settlement, providerResult, resultContentSha256);
  return Object.freeze({ providerResult: Object.freeze(providerResult), settledResultBytes, resultContentSha256, evidence, settlementOrigin: settlement.kind === 'executed' ? 'executed' : settlement.settlementOrigin });
}

function settledEvidence(settlement: ToolSettlementInput, providerResult: ToolResult, resultHash: string): SettledToolEvidence {
  if (!providerResult.success || settlement.kind === 'synthetic') return Object.freeze({ kind: 'none' });
  const evidence = settlement.execution.evidence;
  switch (settlement.resultPolicyTemplate.evidenceMode) {
    case 'none': if (evidence.kind !== 'none') throw new Error('None-mode tool execution supplied evidence.'); return Object.freeze({ kind: 'none' });
    case 'observational_query': if (evidence.kind !== 'observational_result_bytes') throw new Error('Observational tool execution supplied wrong evidence.'); return Object.freeze({ kind: 'observational_query', observedSha256: resultHash });
    case 'canonical_locator': if (evidence.kind !== 'canonical_locator') throw new Error('Canonical tool execution supplied wrong evidence.'); return Object.freeze({ kind: 'canonical_locator', locator: evidence.locator, sha256: evidence.sha256 });
  }
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function appendOne(conversations: ConversationFileContext, message: AgentMessage): void {
  appendConversationBatch(conversations, [message]);
}

function appendVisibleBatch(conversations: ConversationFileContext, messages: AgentMessage[]): void {
  appendConversationBatch(conversations, messages);
}
