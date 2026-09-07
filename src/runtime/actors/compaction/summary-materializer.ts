import { Buffer } from 'node:buffer';

import { canonicalJson, MODEL_RECOVERY_NOTICE_TEXT, contentPolicyRefusalProjectionText, type AgentMessage, type CompactedHistory, type ConversationSessionId,
} from '../../../schemas/index.js';
import type { ValidatedConversation } from '../../../contracts/conversation-validation.js';
import { composeContextProjection, type SummarizerContextItem } from '../context/composition-projector.js';
import {
  admitSummaryRequest,
  buildSummaryRequestInput,
  invokeSummaryRequest,
  type SummaryRequestItem,
  type SummaryRequestSerialization,
  type SummarizerProviderPort,
} from './summarizer.js';

export const SUMMARY_LEAF_INSTRUCTION =
  'Summarize the labeled Saivage conversation material below as one concise prose summary. Preserve the labeled order and source identities. Do not include recoverable-evidence pointer sections.';
export const SUMMARY_REDUCTION_INSTRUCTION =
  'Merge the ordered labeled Saivage summary sections below into one concise historical prose summary. Do not include recoverable-evidence pointer sections.';
export const EMPTY_COVERAGE_SUMMARY = 'These rounds contained no provider-visible conversation content.';

type SummaryMaterialBudget = Readonly<{
  inputBudgetTokens: number;
  completionReserveTokens: number;
}>;

type MaterializationContext = Readonly<{
  conversation: ValidatedConversation;
  summarizerProvider: SummarizerProviderPort;
  budget: SummaryMaterialBudget;
  signal: AbortSignal;
}>;

type IncrementalSummaryMaterializer = Readonly<{
  materializedThrough: number;
  materializeThrough(cutoffCount: number): Promise<string>;
}>;

export function createIncrementalSummaryMaterializer(args: {
  conversation: ValidatedConversation;
  inheritedHistory: CompactedHistory | null;
  summarizerProvider: SummarizerProviderPort;
  budget: SummaryMaterialBudget;
  signal: AbortSignal;
}): IncrementalSummaryMaterializer {
  const context: MaterializationContext = {
    conversation: args.conversation,
    summarizerProvider: args.summarizerProvider,
    budget: args.budget,
    signal: args.signal,
  };
  let materializedThrough = 0;
  let accumulatedSummaryText = args.inheritedHistory?.summaryText ?? null;
  let hasCurrentSegmentSummaryMaterial = false;
  let inheritedRecoveryFolded = false;
  let inheritedRefusalFolded = false;

  return {
    get materializedThrough() {
      return materializedThrough;
    },
    async materializeThrough(cutoffCount: number): Promise<string> {
      if (!Number.isInteger(cutoffCount) || cutoffCount <= materializedThrough || cutoffCount > args.conversation.sourceRows.length)
        throw new Error(
          `Incremental summary cutoff must be an integer greater than ${materializedThrough} and no greater than ${args.conversation.sourceRows.length}; received ${cutoffCount}.`,
        );
      const incrementRows = args.conversation.sourceRows.slice(materializedThrough, cutoffCount);
      const newlySuperseded = supersededSlotItems({
        inheritedHistory: args.inheritedHistory,
        incrementRows,
        sourceSessionId: args.conversation.sourceSessionId,
        includeRecovery: !inheritedRecoveryFolded,
        includeRefusal: !inheritedRefusalFolded,
      });
      const leafItems = buildLeafItems(args.conversation, incrementRows);
      if (leafItems.length === 0) {
        if (accumulatedSummaryText !== null && !hasCurrentSegmentSummaryMaterial)
          throw new Error('Compaction found no newly covered conversation content.');
        materializedThrough = cutoffCount;
        return accumulatedSummaryText ?? EMPTY_COVERAGE_SUMMARY;
      }

      const leafOutputs = await summarizeItemRequests(context, leafItems, SUMMARY_LEAF_INSTRUCTION);
      const reductionItems: SummaryRequestItem[] = [];
      if (accumulatedSummaryText !== null) reductionItems.push(priorSummaryItem(accumulatedSummaryText));
      reductionItems.push(...newlySuperseded.items);
      for (const [index, output] of leafOutputs.entries()) reductionItems.push(reductionOutputItem(output, index, leafOutputs.length));
      const nextSummaryText = await reduceToFinalSummary(context, reductionItems);

      accumulatedSummaryText = nextSummaryText;
      hasCurrentSegmentSummaryMaterial = true;
      inheritedRecoveryFolded ||= newlySuperseded.recovery;
      inheritedRefusalFolded ||= newlySuperseded.refusal;
      materializedThrough = cutoffCount;
      return nextSummaryText;
    },
  };
}

function measureRequest(context: MaterializationContext, items: readonly SummaryRequestItem[], instruction: string): SummaryRequestSerialization {
  return context.summarizerProvider.serializeSummaryRequest(
    buildSummaryRequestInput({
      candidate: context.summarizerProvider.candidate,
      sourceSessionId: context.conversation.sourceSessionId,
      instruction,
      items,
    }),
  );
}

type AdmittedSummaryGroup = Readonly<{
  items: readonly SummaryRequestItem[];
  serialization: SummaryRequestSerialization;
}>;

function admitGroup(context: MaterializationContext, items: readonly SummaryRequestItem[], instruction: string): AdmittedSummaryGroup | null {
  const serialization = measureRequest(context, items, instruction);
  return admitSummaryRequest({ serialization, ...context.budget }).kind === 'admitted' ? { items, serialization } : null;
}

function assertOverheadFits(context: MaterializationContext, instruction: string): void {
  if (!admitGroup(context, [], instruction))
    throw new Error(
      'Summary request fixed overhead (instruction, labels, message wrappers, and the completion reserve) does not fit the compaction input budget.',
    );
}

async function summarizeItemRequests(context: MaterializationContext, items: readonly SummaryRequestItem[], instruction: string): Promise<string[]> {
  assertOverheadFits(context, instruction);
  const outputs: string[] = [];
  for (const group of packSummaryItems(context, items, instruction)) {
    context.signal.throwIfAborted();
    assertCodeOwnedSemanticsUnique(group.items);
    const input = buildSummaryRequestInput({
      candidate: context.summarizerProvider.candidate,
      sourceSessionId: context.conversation.sourceSessionId,
      instruction,
      items: group.items,
    });
    outputs.push(
      await invokeSummaryRequest({
        input,
        admitted: group.serialization,
        summarizerProvider: context.summarizerProvider,
        signal: context.signal,
      }),
    );
  }
  return outputs;
}

function packSummaryItems(
  context: MaterializationContext,
  items: readonly SummaryRequestItem[],
  instruction: string,
): readonly AdmittedSummaryGroup[] {
  const groups: AdmittedSummaryGroup[] = [];
  let current: SummaryRequestItem[] = [];
  let currentAdmission: AdmittedSummaryGroup | null = null;
  for (const item of items) {
    const extended = admitGroup(context, [...current, item], instruction);
    if (extended) {
      current = [...current, item];
      currentAdmission = extended;
      continue;
    }
    if (currentAdmission) {
      groups.push(currentAdmission);
      current = [];
      currentAdmission = null;
    }
    const alone = admitGroup(context, [item], instruction);
    if (alone) {
      current = [item];
      currentAdmission = alone;
      continue;
    }
    groups.push(...chunkOversizedItem(context, item, instruction));
  }
  if (currentAdmission) groups.push(currentAdmission);
  return groups;
}

function chunkOversizedItem(
  context: MaterializationContext,
  item: SummaryRequestItem,
  instruction: string,
): readonly AdmittedSummaryGroup[] {
  const bytes = Buffer.from(item.content, 'utf8');
  for (let parts = 1; ; parts++) {
    const chunks = splitUtf8Chunks(bytes, parts);
    const pieces = chunks.map((chunk, index) => ({
      ...item,
      label: `${item.label} [part ${index + 1}/${parts}]`,
      content: chunk.toString('utf8'),
    }));
    const groups = pieces.map((piece) => admitGroup(context, [piece], instruction));
    if (groups.every((group) => group !== null)) return groups as readonly AdmittedSummaryGroup[];
    if (chunks.some((chunk) => chunk.length === 0))
      throw new Error(
        'Summary request fixed overhead (instruction, labels, message wrappers, and the completion reserve) does not fit the compaction input budget.',
      );
  }
}

function splitUtf8Chunks(bytes: Buffer, parts: number): readonly Buffer[] {
  const chunks: Buffer[] = [];
  let start = 0;
  for (let index = 1; index <= parts; index++) {
    let boundary = Math.round((index * bytes.byteLength) / parts);
    while (boundary < bytes.byteLength && (bytes[boundary]! & 0xc0) === 0x80) boundary++;
    if (index === parts) boundary = bytes.byteLength;
    chunks.push(bytes.subarray(start, boundary));
    start = boundary;
  }
  return chunks;
}

async function reduceToFinalSummary(context: MaterializationContext, items: readonly SummaryRequestItem[]): Promise<string> {
  let current = items;
  for (;;) {
    if (current.length === 1 && admitGroup(context, [current[0]!], SUMMARY_REDUCTION_INSTRUCTION)) return current[0]!.content;
    const outputs = await summarizeItemRequests(context, current, SUMMARY_REDUCTION_INSTRUCTION);
    if (aggregateBytes(outputs) >= aggregateBytes(current.map((item) => item.content)))
      throw new Error('Summary reduction level did not reduce the measured aggregate; refusing to loop.');
    current = outputs.map((output, index) => reductionOutputItem(output, index, outputs.length));
  }
}

function aggregateBytes(contents: readonly string[]): number {
  return contents.reduce((total, content) => total + Buffer.byteLength(content, 'utf8'), 0);
}

function buildLeafItems(
  conversation: ValidatedConversation,
  coveredRows: readonly AgentMessage[],
): readonly SummaryRequestItem[] {
  const items: SummaryRequestItem[] = [];
  const composed = composeContextProjection({
    sourceSessionId: conversation.sourceSessionId,
    effectiveHistory: null,
    dynamicBlocks: [],
    uncoveredRows: coveredRows,
  });
  for (const item of composed.summarizer) items.push(convertSummarizerContextItem(item));
  return items;
}

function supersededSlotItems(args: {
  inheritedHistory: CompactedHistory | null;
  incrementRows: readonly AgentMessage[];
  sourceSessionId: ConversationSessionId;
  includeRecovery: boolean;
  includeRefusal: boolean;
}): Readonly<{ items: readonly SummaryRequestItem[]; recovery: boolean; refusal: boolean }> {
  const facts = args.inheritedHistory?.requiredModelFacts;
  if (!facts) return { items: [], recovery: false, refusal: false };
  const items: SummaryRequestItem[] = [];
  const recovery = args.includeRecovery && facts.latestRecovery !== null && args.incrementRows.some((row) => row.kind === 'model_recovered');
  if (recovery && facts.latestRecovery)
    items.push({
      label: `[kind=superseded_recovery_notice source=${facts.latestRecovery.sourceMessageId}]`,
      role: 'system',
      content: `An earlier runtime interruption of activation ${facts.latestRecovery.activationInputId} was recovered before this history; its recovery notice read exactly: ${MODEL_RECOVERY_NOTICE_TEXT}`,
      codeOwnedSemantic: null,
    });
  const refusal = args.includeRefusal && facts.latestContentPolicyRefusal !== null && args.incrementRows.some((row) => row.kind === 'content_policy_refusal');
  if (refusal && facts.latestContentPolicyRefusal)
    items.push({
      label: `[kind=superseded_refusal_notice source=${facts.latestContentPolicyRefusal.markerId}]`,
      role: 'user',
      content: `An earlier activation ${facts.latestContentPolicyRefusal.activationInputId} ended after repeated provider content-policy refusal; its replanning notice read exactly: ${contentPolicyRefusalProjectionText(args.sourceSessionId, facts.latestContentPolicyRefusal.markerId)}`,
      codeOwnedSemantic: null,
    });
  return { items, recovery, refusal };
}

function convertSummarizerContextItem(item: SummarizerContextItem): SummaryRequestItem {
  switch (item.kind) {
    case 'inherited_summary':
      throw new Error('Summary materialization composes covered rows without inherited history facts.');
    case 'message':
      return {
        label: `[kind=message source=${item.sourceId} role=${item.role} semantic=${item.semantic}${item.responsesPrivateMessageId ? ` responses_private=${item.responsesPrivateMessageId}` : ''}]`,
        role: item.role,
        content: item.content,
        codeOwnedSemantic: item.semantic === 'recovery_notice' || item.semantic === 'refusal_notice' ? item.content : null,
      };
    case 'settled_tool_bundle':
      return {
        label: `[kind=settled_tool_bundle source=${item.identity.source_input_id}:${item.identity.tool_call_id} tool=${item.toolName} audience=${item.policy.settledAudience}]`,
        role: 'user',
        content: `tool_call_arguments=${item.callArguments}\ntool_result_content=${item.resultContent}`,
        codeOwnedSemantic: null,
      };
    case 'evidence':
      return {
        label: `[kind=evidence source=${item.sourceId} mode=${item.evidence.kind}]`,
        role: 'user',
        content: canonicalJson(item.evidence),
        codeOwnedSemantic: null,
      };
  }
}

function priorSummaryItem(summaryText: string): SummaryRequestItem {
  return { label: '[kind=prior_accumulated_summary]', role: 'system', content: summaryText, codeOwnedSemantic: null };
}

function reductionOutputItem(output: string, index: number, total: number): SummaryRequestItem {
  return { label: `[kind=reduction_output index=${index + 1}/${total}]`, role: 'user', content: output, codeOwnedSemantic: null };
}

function assertCodeOwnedSemanticsUnique(items: readonly SummaryRequestItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.codeOwnedSemantic === null) continue;
    if (seen.has(item.codeOwnedSemantic))
      throw new Error('One materialized summary request contains the same exact code-owned semantic more than once.');
    seen.add(item.codeOwnedSemantic);
  }
}
