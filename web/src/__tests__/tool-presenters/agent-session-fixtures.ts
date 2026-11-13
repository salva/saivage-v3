import { MODEL_RECOVERY_NOTICE_TEXT } from '../../../../src/schemas/context-policy.js';

// These public envelopes are pinned against the production binder/executor in
// tests/tools/global-agent-session-tools.test.ts. Only the random segment UUID
// and index creation timestamp are replaced by stable fixture values there.
// The compacted context's randomly authored refusal-marker UUID is also fixed.
export const sessionId = 'agent:planner:project';
export const messageId = '11111111-1111-4111-8111-111111111111:tool-result:call-1';
export const timestamp = '2026-07-18T00:00:00.000Z';
export const segmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const page = (items: unknown[]) => ({ total: items.length, position: { item_index: 0, item_byte_offset: 0 }, returned: items.length, next: null, items });
export const metadata = {
  session: { id: sessionId, agent_name: 'planner', session_scope: 'card', card_id: 'project', started_at: timestamp, status: 'active', activity: 'busy', compaction: null },
  ownership: 'active', segment_version: 1, segment_id: segmentId, has_segment_context: false, total_visible_entries: 4,
};
export const diagnosticRows = [
  { message_id: 'activation', timestamp, kind: 'activity', role: 'system', round_id: 'r-pre-11111111111141118111111111111111', message_index: 0, block_index: 0, origin: 'segment_row', event: 'activation_open', input_id: '11111111-1111-4111-8111-111111111111', instructions_omitted: true, instructions: { kind: 'unavailable', reason: 'not_recorded' } },
  { message_id: '11111111-1111-4111-8111-111111111111:tool-call:call-1', timestamp, kind: 'tool_call', role: 'assistant', round_id: 'r-assistant-11111111111141118111111111111111', message_index: 2, block_index: 0, origin: 'segment_row', tool: 'webfetch', tool_call_id: 'call-1', preview: '{"role":"assistant","tool_calls":[{"id":"call-1","type":"function","function":{"name":"webfetch","arguments":"{}"}}]}', preview_utf8_bytes: 117, content_utf8_bytes: 117, preview_complete: true },
  { message_id: messageId, timestamp, kind: 'tool_result', role: 'tool', round_id: 'r-assistant-11111111111141118111111111111111', message_index: 2, block_index: 0, origin: 'segment_row', tool: 'webfetch', tool_call_id: 'call-1', success: false, settlement_origin: 'execution_failed', preview: '<img src=x onerror=alert(1)> token=[REDACTED] final-Z', preview_utf8_bytes: 53, content_utf8_bytes: 53, preview_complete: true },
];
export const diagnostics = { ...metadata, section: 'diagnostics', scope: 'current_segment_rows', total_diagnostic_entries: 3, selected_diagnostic_entries: 3, omitted_earlier_diagnostic_entries: 0, first_message_id: 'activation', last_message_id: messageId, first_timestamp: timestamp, last_timestamp: timestamp, historical_segments_included: false, inherited_notices_included: false, diagnostics: page(diagnosticRows) };
export const exactEntry = { id: messageId, session_id: sessionId, role: 'tool', kind: 'tool_result', tool: 'webfetch', tool_call_id: 'call-1', content: '{"success":false,"error":"<img src=x onerror=alert(1)> token=[REDACTED] final-Z"}', context_policy: { kind: 'tool_result', settlement_origin: 'execution_failed' }, round_id: 'r-assistant-11111111111141118111111111111111', message_index: 2, block_index: 0, timestamp };
export const message = { ...metadata, section: 'message', entry_origin: 'segment_row', message: page([exactEntry]) };
export const context = { ...metadata, section: 'context', context: page([]) };
export const messages = { ...metadata, section: 'messages', messages: page([exactEntry]) };
export const missingMessage = { success: false, error: 'Agent message not found in the current visible segment.', data: { code: 'agent_message_not_found', session_id: sessionId, segment_id: segmentId, segment_version: 1 } };
export const emptySession = { success: false, error: 'Agent session has no current conversation segment.', data: { code: 'agent_session_empty', session_id: sessionId } };
export const missingSession = { success: false, error: 'Agent session not found.', data: { code: 'agent_session_not_found', session_id: 'agent:executor:card-z' } };
export const unavailable = { success: false, error: 'Current Agent session state unavailable; restart required.', data: { code: 'current_state_unavailable', resource: 'conversation', owner_id: sessionId, restart_required: true } };
export const emptyDiagnostics = { ...diagnostics, total_visible_entries: 1, total_diagnostic_entries: 0, selected_diagnostic_entries: 0, first_message_id: null, last_message_id: null, first_timestamp: null, last_timestamp: null, diagnostics: page([]) };
export const tailDiagnostics = { ...diagnostics, selected_diagnostic_entries: 1, omitted_earlier_diagnostic_entries: 2, first_message_id: messageId, diagnostics: page([diagnosticRows[2]]) };
export const partialDiagnostics = { ...diagnostics, diagnostics: { ...page([diagnosticRows[0]]), total: 3, next: { item_index: 1, item_byte_offset: 0 } } };
export const preparedDiagnostic = { ...diagnosticRows[0], message_id: 'activation-11111111-1111-4111-8111-111111111111', instructions: { kind: 'prepared', activation_id: '11111111-1111-4111-8111-111111111111', node_id: 'plan', caller: { kind: 'root' } } };
export const successfulDiagnostic = { ...diagnosticRows[2], success: true, settlement_origin: 'executed', preview: '{"data":{"activated":true},"success":true}', preview_utf8_bytes: 42, content_utf8_bytes: 42 };
export const preparedDiagnostics = { ...diagnostics, total_visible_entries: 3, first_message_id: preparedDiagnostic.message_id, diagnostics: page([preparedDiagnostic, diagnosticRows[1], successfulDiagnostic]) };
export const incompleteDiagnostic = { ...diagnosticRows[2], preview: 'x'.repeat(512), preview_utf8_bytes: 512, content_utf8_bytes: 900, preview_complete: false };
export const tailIncompleteDiagnostics = { ...tailDiagnostics, total_visible_entries: 3, diagnostics: page([incompleteDiagnostic]) };
const exactEntryBytes = JSON.stringify(exactEntry).length;
export const partialItem = { content_hex: '227d', utf8_bytes: 2, offset_bytes: exactEntryBytes - 2, next_offset_bytes: exactEntryBytes, total_bytes: exactEntryBytes };
export const slicedMessage = { ...message, message: { ...page([partialItem]), position: { item_index: 0, item_byte_offset: partialItem.offset_bytes } } };
export const carriedEntry = { id: '00000000-0000-4000-8000-000000000001:model-recovered', session_id: sessionId, role: 'system', kind: 'text', content: MODEL_RECOVERY_NOTICE_TEXT, context_policy: { kind: 'content', compactable: true }, round_id: 'r-pre-11e594f481958c10e3015d0bf0447a22', message_index: 0, block_index: 1, timestamp: '1970-01-01T00:00:00.000Z' };
export const carriedMessage = { ...message, total_visible_entries: 2, segment_version: 3, has_segment_context: true, entry_origin: 'carried_synthesized_notice', original_event_metadata: 'not_available', message: page([carriedEntry]) };
const carriedEntryBytes = JSON.stringify(carriedEntry).length;
export const slicedCarriedMessage = { ...carriedMessage, message: { ...page([{ content_hex: '227d', utf8_bytes: 2, offset_bytes: carriedEntryBytes - 2, next_offset_bytes: carriedEntryBytes, total_bytes: carriedEntryBytes }]), position: { item_index: 0, item_byte_offset: carriedEntryBytes - 2 } } };
export const compactedContextRow = {
  kind: 'compacted', source_version: 2,
  covered_through_message_id: '00000000-0000-4000-8000-000000000004:tool-result:call-4',
  summary_text: 'fixture compacted summary', protected_prompts: [],
  required_model_facts: {
    latestRecovery: { activationInputId: '00000000-0000-4000-8000-000000000001', sourceMessageId: carriedEntry.id },
    latestContentPolicyRefusal: { activationInputId: '00000000-0000-4000-8000-000000000002', markerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    latestRecordObservations: [],
  },
  continuation: { kind: 'inherited_open_round', active_segment_kind: 'initial', activation: { input_id: '00000000-0000-4000-8000-000000000004', marker_id: 'activation-4' } },
};
export const compactedContext = { ...context, segment_version: 3, total_visible_entries: 2, has_segment_context: true, context: page([compactedContextRow]) };
