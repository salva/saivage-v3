import { canonicalJson, parseActivationOpenPayload } from '../../schemas/index.js';
import { ToolResultSchema, type AgentConversationEntry } from '../../contracts/index.js';
import { utf8SafeSlice } from '../../utils/index.js';
import { redactTextWithStablePrefixesForOutbound } from '../../redaction/index.js';

const diagnosticKinds = new Set([
  'activity',
  'model_issue',
  'model_recovered',
  'content_policy_refusal',
  'tool_call',
  'tool_result',
]);

/** Input is the complete public outbound projection, never raw stored content. */
export function projectConversationDiagnostic(entry: AgentConversationEntry) {
  if (!diagnosticKinds.has(entry.kind)) return null;
  const metadata = {
    message_id: entry.id,
    timestamp: entry.timestamp,
    kind: entry.kind,
    role: entry.role,
    round_id: entry.round_id,
    message_index: entry.message_index,
    block_index: entry.block_index,
    origin: 'segment_row' as const,
    ...(entry.tool === undefined ? {} : { tool: entry.tool }),
    ...(entry.tool_call_id === undefined ? {} : { tool_call_id: entry.tool_call_id }),
  };
  if (entry.kind === 'activity') {
    const activation = parseActivationOpenPayload(entry.content, entry.session_id, entry.timestamp);
    if (activation) {
      const instructions = activation.instructions;
      return {
        ...metadata,
        event: activation.event,
        input_id: activation.input_id,
        instructions_omitted: true,
        instructions:
          instructions.kind === 'prepared'
            ? {
                kind: instructions.kind,
                activation_id: instructions.activation_id,
                node_id: instructions.node?.node_id ?? null,
                caller: instructions.caller,
              }
            : { kind: instructions.kind, reason: instructions.reason },
      };
    }
  }
  const result =
    entry.kind === 'tool_result' ? ToolResultSchema.parse(JSON.parse(entry.content)) : null;
  const settlement = result === null ? {} : toolSettlementMetadata(entry, result.success);
  const content =
    result === null ? entry.content : result.success ? canonicalJson(result) : result.error;
  const stable = redactTextWithStablePrefixesForOutbound(content);
  let end = utf8SafeSlice(stable.text, 0, 512).content.length;
  end = Math.min(end, stable.maxPrefixEnd);
  const crossing = stable.indivisibleSpans.find((span) => span.start < end && end < span.end);
  if (crossing) end = crossing.start;
  const preview = stable.text.slice(0, end);
  const previewBytes = Buffer.byteLength(preview, 'utf8');
  const contentBytes = Buffer.byteLength(stable.text, 'utf8');
  return {
    ...metadata,
    ...settlement,
    preview,
    preview_utf8_bytes: previewBytes,
    content_utf8_bytes: contentBytes,
    preview_complete: previewBytes === contentBytes,
  };
}

function toolSettlementMetadata(entry: AgentConversationEntry, success: boolean) {
  if (entry.context_policy.kind !== 'tool_result')
    throw new Error(`Tool result '${entry.id}' is missing its tool_result context policy.`);
  return { success, settlement_origin: entry.context_policy.settlement_origin };
}
