import {
  agentMessageSchema,
  CONTENT_POLICY_RETRY_TEXT,
  contentPolicyRefusalProjectionText,
  DURABLE_PRIMARY_CONTENT_POLICY,
  MODEL_RECOVERY_NOTICE_TEXT,
  type AgentMessage,
  type ConversationSessionId,
} from '../../../schemas/index.js';
import { loggedToolCallIdentity, loggedToolCallKey, loggedToolResultIdentity, type LoggedToolMessageIdentity } from '../../../schemas/message-identity.js';
import { deterministicRoundId } from '../../../schemas/round-id-server.js';
import { validateResponsesPairs } from '../../../agents/llm-openai-responses-mapper.js';
import type { ProviderConversationProjection } from '../../../agents/llm-contracts.js';
import { parseToolCallMessageForModel } from '../../../contracts/persisted-tool-call.js';
import { contextContentSha256, selectLatestContextBlocks, type ContextBlock, type ContextEvidence } from './context-blocks.js';
import { classifyConversationRowPolicy, settledToolBundlePolicy, type SettledToolBundlePolicy } from './row-policy.js';

const EPOCH_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export type EffectiveRequiredModelFacts = Readonly<{
  latestRecovery: Readonly<{ sourceMessageId: string; activationInputId: string }> | null;
  latestContentPolicyRefusal: Readonly<{ markerId: string; activationInputId: string }> | null;
}>;

export type EffectiveCompactedHistoryFacts = Readonly<{
  summaryText: string;
  historyMessageId: string;
  historyTimestamp: string;
  requiredModelFacts: EffectiveRequiredModelFacts;
}>;

export type ProjectedCanonicalSemantic = 'direct' | 'recovery_notice' | 'refusal_notice' | 'retry_notice';

export type PrimaryContextEntry =
  | Readonly<{ origin: 'history_summary'; content: string; messageId: string; timestamp: string }>
  | Readonly<{ origin: 'dynamic'; block: ContextBlock }>
  | Readonly<{ origin: 'canonical'; row: AgentMessage; semantic: ProjectedCanonicalSemantic }>;

export type SummarizerContextItem =
  | Readonly<{ kind: 'inherited_summary'; content: string }>
  | Readonly<{ kind: 'message'; sourceId: string; role: 'system' | 'user' | 'assistant'; content: string; semantic: ProjectedCanonicalSemantic; responsesPrivateMessageId: string | null }>
  | Readonly<{ kind: 'settled_tool_bundle'; identity: LoggedToolMessageIdentity; toolName: string; callArguments: string; resultContent: string; policy: SettledToolBundlePolicy; responsesPrivateMessageId: string | null }>
  | Readonly<{ kind: 'evidence'; sourceId: string; evidence: ContextEvidence }>;

export type ComposedContextProjection = Readonly<{
  sourceSessionId: ConversationSessionId;
  primary: readonly PrimaryContextEntry[];
  recoveryNoticeMessageId: string | null;
  refusalNoticeMessageId: string | null;
  summarizer: readonly SummarizerContextItem[];
}>;

type RepeatedEventSelection = Readonly<{
  recovery: Readonly<{ kind: 'row'; row: AgentMessage } | { kind: 'inherited_slot' }> | null;
  refusal: Readonly<{ kind: 'row'; row: AgentMessage } | { kind: 'inherited_slot' }> | null;
}>;

type SettledBundle = Readonly<{
  call: AgentMessage;
  result: AgentMessage;
  policy: SettledToolBundlePolicy;
  callArguments: string;
  responsesPrivateMessageId: string | null;
}>;

export function composeContextProjection(args: {
  sourceSessionId: ConversationSessionId;
  effectiveHistory: EffectiveCompactedHistoryFacts | null;
  dynamicBlocks: readonly ContextBlock[];
  uncoveredRows: readonly AgentMessage[];
}): ComposedContextProjection {
  const dynamic = selectVerifiedLatestDynamicBlocks(args.dynamicBlocks);
  validateResponsesPairs(args.sourceSessionId, [...args.uncoveredRows]);
  const settledBundles = groupSettledToolBundles(args.uncoveredRows);
  const selection = selectRepeatedEventOccurrences(args.uncoveredRows, args.effectiveHistory?.requiredModelFacts ?? null);

  const primary: PrimaryContextEntry[] = [];
  const summarizer: SummarizerContextItem[] = [];
  if (args.effectiveHistory) {
    primary.push({ origin: 'history_summary', content: args.effectiveHistory.summaryText, messageId: args.effectiveHistory.historyMessageId, timestamp: args.effectiveHistory.historyTimestamp });
    summarizer.push({ kind: 'inherited_summary', content: args.effectiveHistory.summaryText });
  }
  if (selection.recovery?.kind === 'inherited_slot') {
    primary.push({ origin: 'canonical', row: recoveryNoticeFromInheritedSlot(args.sourceSessionId, args.effectiveHistory!.requiredModelFacts.latestRecovery!), semantic: 'recovery_notice' });
    summarizer.push(inheritedRecoveryMessageItem(args.effectiveHistory!.requiredModelFacts.latestRecovery!));
  }
  if (selection.refusal?.kind === 'inherited_slot') {
    primary.push({ origin: 'canonical', row: refusalNoticeFromInheritedSlot(args.sourceSessionId, args.effectiveHistory!.requiredModelFacts.latestContentPolicyRefusal!), semantic: 'refusal_notice' });
    summarizer.push(inheritedRefusalMessageItem(args.sourceSessionId, args.effectiveHistory!.requiredModelFacts.latestContentPolicyRefusal!));
  }
  for (const block of dynamic) primary.push({ origin: 'dynamic', block });

  for (const row of args.uncoveredRows) {
    const policy = classifyConversationRowPolicy(row);
    if (policy.kind === 'structural') {
      const behavior = policy.projection.behavior;
      if (behavior === 'activation_boundary' || behavior === 'provider_failure' || behavior === 'responses_private') {
        if (behavior === 'responses_private') primary.push({ origin: 'canonical', row, semantic: 'direct' });
        continue;
      }
      if (behavior === 'model_recovery_notice') {
        if (selection.recovery?.kind !== 'row' || selection.recovery.row !== row) continue;
        if (row.content !== MODEL_RECOVERY_NOTICE_TEXT) throw new Error(`Recovery notice '${row.id}' does not carry the exact canonical recovery warning.`);
        primary.push({ origin: 'canonical', row: syntheticProjectionRow(row, 'system', MODEL_RECOVERY_NOTICE_TEXT), semantic: 'recovery_notice' });
        summarizer.push({ kind: 'message', sourceId: row.id, role: 'system', content: MODEL_RECOVERY_NOTICE_TEXT, semantic: 'recovery_notice', responsesPrivateMessageId: null });
        continue;
      }
      if (selection.refusal?.kind !== 'row' || selection.refusal.row !== row) continue;
      const content = contentPolicyRefusalProjectionText(args.sourceSessionId, row.id);
      primary.push({ origin: 'canonical', row: syntheticProjectionRow(row, 'user', content), semantic: 'refusal_notice' });
      summarizer.push({ kind: 'message', sourceId: row.id, role: 'user', content, semantic: 'refusal_notice', responsesPrivateMessageId: null });
      continue;
    }
    if (policy.kind === 'tool_exchange') {
      primary.push({ origin: 'canonical', row, semantic: 'direct' });
      if (row.kind === 'tool_result') {
        const identity = requireToolResultIdentity(row);
        const bundle = settledBundles.get(loggedToolCallKey(identity));
        if (!bundle) throw new Error(`Tool result '${row.id}' has no settled bundle.`);
        if (bundle.policy.settledAudience === 'evidence_only') summarizer.push({ kind: 'evidence', sourceId: bundle.call.id, evidence: bundle.policy.evidence });
        else summarizer.push({ kind: 'settled_tool_bundle', identity, toolName: bundle.call.tool!, callArguments: bundle.callArguments, resultContent: row.content, policy: bundle.policy, responsesPrivateMessageId: bundle.responsesPrivateMessageId });
      }
      continue;
    }
    if (policy.projection.rendering === 'code_owned_retry_text') {
      primary.push({ origin: 'canonical', row: syntheticProjectionRow(row, 'user', CONTENT_POLICY_RETRY_TEXT), semantic: 'retry_notice' });
      summarizer.push({ kind: 'message', sourceId: row.id, role: 'user', content: CONTENT_POLICY_RETRY_TEXT, semantic: 'retry_notice', responsesPrivateMessageId: null });
      continue;
    }
    primary.push({ origin: 'canonical', row, semantic: 'direct' });
    if (row.context_policy.kind !== 'content') throw new Error(`Conversation row '${row.id}' is missing its content policy.`);
    if (row.context_policy.audience === 'evidence_only') summarizer.push({ kind: 'evidence', sourceId: row.id, evidence: row.context_policy.evidence });
    else summarizer.push({ kind: 'message', sourceId: row.id, role: messageRoleOf(row), content: row.content, semantic: 'direct', responsesPrivateMessageId: row.provider_projection?.private_message_id ?? null });
  }

  return Object.freeze({
    sourceSessionId: args.sourceSessionId,
    primary: Object.freeze(primary),
    recoveryNoticeMessageId: recoveryNoticeId(selection, args.effectiveHistory),
    refusalNoticeMessageId: refusalNoticeId(selection, args.effectiveHistory),
    summarizer: Object.freeze(summarizer),
  });
}

export function providerConversationFromComposedContext(composed: ComposedContextProjection): ProviderConversationProjection {
  const messages = composed.primary.map((entry) => {
    if (entry.origin === 'history_summary')
      return agentMessageSchema.parse({ id: entry.messageId, session_id: composed.sourceSessionId, role: 'system', kind: 'text', content: entry.content, context_policy: DURABLE_PRIMARY_CONTENT_POLICY, round_id: deterministicRoundId('pre', entry.messageId), message_index: 0, block_index: 0, timestamp: entry.timestamp });
    if (entry.origin !== 'canonical') throw new Error(`Composed primary entry of origin '${entry.origin}' has no provider conversation row representation.`);
    return entry.row;
  });
  return { sourceSessionId: composed.sourceSessionId, messages };
}

export function projectedCanonicalRowContent(row: AgentMessage): string {
  if (row.kind === 'content_policy_refusal') return contentPolicyRefusalProjectionText(row.session_id, row.id);
  if (row.kind === 'content_policy_retry') return CONTENT_POLICY_RETRY_TEXT;
  if (row.kind === 'model_recovered') return MODEL_RECOVERY_NOTICE_TEXT;
  return row.content;
}

export function currentCoveredRequiredFactRows(args: {
  sourceSessionId: ConversationSessionId;
  requiredModelFacts: EffectiveRequiredModelFacts;
  uncoveredRows: readonly AgentMessage[];
}): readonly AgentMessage[] {
  const selection = selectRepeatedEventOccurrences(args.uncoveredRows, args.requiredModelFacts);
  const rows: AgentMessage[] = [];
  if (selection.recovery?.kind === 'inherited_slot') rows.push(recoveryNoticeFromInheritedSlot(args.sourceSessionId, args.requiredModelFacts.latestRecovery!));
  if (selection.refusal?.kind === 'inherited_slot') rows.push(refusalNoticeFromInheritedSlot(args.sourceSessionId, args.requiredModelFacts.latestContentPolicyRefusal!));
  return Object.freeze(rows);
}

function selectVerifiedLatestDynamicBlocks(blocks: readonly ContextBlock[]): readonly ContextBlock[] {
  for (const block of blocks) {
    if (block.replacement.kind !== 'latest_snapshot') continue;
    if (contextContentSha256(block.content) !== block.replacement.contentSha256) throw new Error(`Dynamic context block '${block.id}' replacement hash does not commit to its exact content.`);
  }
  return selectLatestContextBlocks(blocks);
}

function groupSettledToolBundles(rows: readonly AgentMessage[]): Map<string, SettledBundle> {
  const openCalls = new Map<string, AgentMessage>();
  const settled = new Map<string, SettledBundle>();
  for (const row of rows) {
    if (row.kind === 'tool_call') {
      const key = loggedToolCallKey(requireToolCallIdentity(row));
      if (openCalls.has(key) || settled.has(key)) throw new Error(`Tool call '${row.id}' repeats the composite identity of an earlier call.`);
      openCalls.set(key, row);
      continue;
    }
    if (row.kind !== 'tool_result') continue;
    const identity = requireToolResultIdentity(row);
    const key = loggedToolCallKey(identity);
    const call = openCalls.get(key);
    if (!call) throw new Error(`Tool result '${row.id}' settles no prior unmatched tool call.`);
    openCalls.delete(key);
    const embedded = parseToolCallMessageForModel(JSON.parse(call.content));
    settled.set(key, Object.freeze({
      call,
      result: row,
      policy: settledToolBundlePolicy(call, row),
      callArguments: embedded.arguments,
      responsesPrivateMessageId: call.provider_projection?.private_message_id ?? null,
    }));
  }
  return settled;
}

function selectRepeatedEventOccurrences(rows: readonly AgentMessage[], facts: EffectiveRequiredModelFacts | null): RepeatedEventSelection {
  let recovery: RepeatedEventSelection['recovery'] = facts?.latestRecovery ? { kind: 'inherited_slot' } : null;
  let refusal: RepeatedEventSelection['refusal'] = facts?.latestContentPolicyRefusal ? { kind: 'inherited_slot' } : null;
  for (const row of rows) {
    if (row.kind === 'model_recovered') recovery = { kind: 'row', row };
    if (row.kind === 'content_policy_refusal') refusal = { kind: 'row', row };
  }
  return { recovery, refusal };
}

function recoveryNoticeId(selection: RepeatedEventSelection, effectiveHistory: EffectiveCompactedHistoryFacts | null): string | null {
  if (selection.recovery?.kind === 'row') return selection.recovery.row.id;
  if (selection.recovery?.kind === 'inherited_slot') return effectiveHistory!.requiredModelFacts.latestRecovery!.sourceMessageId;
  return null;
}

function refusalNoticeId(selection: RepeatedEventSelection, effectiveHistory: EffectiveCompactedHistoryFacts | null): string | null {
  if (selection.refusal?.kind === 'row') return selection.refusal.row.id;
  if (selection.refusal?.kind === 'inherited_slot') return effectiveHistory!.requiredModelFacts.latestContentPolicyRefusal!.markerId;
  return null;
}

function syntheticProjectionRow(row: AgentMessage, role: 'system' | 'user', content: string): AgentMessage {
  return agentMessageSchema.parse({ ...row, role, kind: 'text', content, context_policy: DURABLE_PRIMARY_CONTENT_POLICY });
}

export function recoveryNoticeFromInheritedSlot(sourceSessionId: ConversationSessionId, slot: NonNullable<EffectiveRequiredModelFacts['latestRecovery']>): AgentMessage {
  if (slot.sourceMessageId !== `${slot.activationInputId}:model-recovered`) throw new Error(`Inherited recovery fact '${slot.sourceMessageId}' does not match its activation identity.`);
  return agentMessageSchema.parse({
    id: slot.sourceMessageId,
    session_id: sourceSessionId,
    role: 'system',
    kind: 'text',
    content: MODEL_RECOVERY_NOTICE_TEXT,
    context_policy: DURABLE_PRIMARY_CONTENT_POLICY,
    round_id: deterministicRoundId('pre', slot.activationInputId),
    message_index: 0,
    block_index: 1,
    timestamp: EPOCH_TIMESTAMP,
  });
}

export function refusalNoticeFromInheritedSlot(sourceSessionId: ConversationSessionId, slot: NonNullable<EffectiveRequiredModelFacts['latestContentPolicyRefusal']>): AgentMessage {
  return agentMessageSchema.parse({
    id: slot.markerId,
    session_id: sourceSessionId,
    role: 'user',
    kind: 'text',
    content: contentPolicyRefusalProjectionText(sourceSessionId, slot.markerId),
    context_policy: DURABLE_PRIMARY_CONTENT_POLICY,
    round_id: deterministicRoundId('assistant', slot.activationInputId),
    message_index: 3,
    block_index: 0,
    timestamp: EPOCH_TIMESTAMP,
  });
}

function inheritedRecoveryMessageItem(slot: NonNullable<EffectiveRequiredModelFacts['latestRecovery']>): Extract<SummarizerContextItem, { kind: 'message' }> {
  return { kind: 'message', sourceId: slot.sourceMessageId, role: 'system', content: MODEL_RECOVERY_NOTICE_TEXT, semantic: 'recovery_notice', responsesPrivateMessageId: null };
}

function inheritedRefusalMessageItem(sourceSessionId: ConversationSessionId, slot: NonNullable<EffectiveRequiredModelFacts['latestContentPolicyRefusal']>): Extract<SummarizerContextItem, { kind: 'message' }> {
  return { kind: 'message', sourceId: slot.markerId, role: 'user', content: contentPolicyRefusalProjectionText(sourceSessionId, slot.markerId), semantic: 'refusal_notice', responsesPrivateMessageId: null };
}

function messageRoleOf(row: AgentMessage): 'system' | 'user' | 'assistant' {
  if (row.role === 'tool') throw new Error(`Content row '${row.id}' cannot carry the tool role.`);
  return row.role;
}

function requireToolCallIdentity(row: AgentMessage): LoggedToolMessageIdentity {
  const identity = loggedToolCallIdentity(row);
  if (!identity) throw new Error(`Tool call '${row.id}' is missing its composite identity.`);
  return identity;
}

function requireToolResultIdentity(row: AgentMessage): LoggedToolMessageIdentity {
  const identity = loggedToolResultIdentity(row);
  if (!identity) throw new Error(`Tool result '${row.id}' is missing its composite identity.`);
  return identity;
}
