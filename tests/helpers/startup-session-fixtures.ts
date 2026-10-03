import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { appendProviderExchangeEntry } from '../../src/persistence/provider-exchange-log.js';
import { providerExchangeFile } from '../../src/persistence/layout.js';
import type { ConversationSessionId } from '../../src/schemas/index.js';
import { toolCallRowPolicy } from './row-policy-fixtures.js';

export function appendStartupPendingCall(projectRoot: string, sessionId: ConversationSessionId, inputId: string): void {
  appendConversationBatch({ projectRoot }, [{
    id: `${inputId}:tool-call:pending`, session_id: sessionId, role: 'assistant', kind: 'tool_call',
    tool: 'read', tool_call_id: 'pending', context_policy: toolCallRowPolicy(),
    content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'pending', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
    round_id: `r-assistant-${inputId.replaceAll('-', '')}`, message_index: 1, block_index: 0,
    timestamp: '2026-10-03T00:00:00.000Z',
  }]);
}

export function appendStartupEvidence(projectRoot: string, sessionId: ConversationSessionId): string {
  const timestamp = '2026-10-03T00:00:00.000Z';
  appendProviderExchangeEntry(projectRoot, sessionId, { type: 'provider_exchange', data: {
    session_id: sessionId, source_input_id: 'startup-evidence', attempt_index: 0, timestamp,
    payload: { contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model: 'test',
      source_input_id: 'startup-evidence', attempt_index: 0, request_params: {}, started_at: timestamp,
      completed_at: timestamp, status: 'ok', terminal_tool_fired: null, assistant_output_ids: [] },
  } });
  return providerExchangeFile(projectRoot, sessionId);
}
