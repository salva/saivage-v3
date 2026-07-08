import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { appendProviderExchangeMessage, conversationMessagesForModel, readConversationMessages } from '../../../src/runtime/actors/conversation-store.js';
import { agentMessageSchema } from '../../../src/schemas/index.js';
import { parseProviderExchangePayload, serializeProviderExchangePayload, type ProviderExchangePayload } from '../../../src/contracts/provider-exchange.js';

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saivage-provider-exchange-test-'));
  initProjectTree(dir);
  return dir;
}

function payload(overrides: Partial<ProviderExchangePayload> = {}): ProviderExchangePayload {
  return {
    contract_id: 'planner.v1',
    contract_name: 'planner',
    transport: 'generic',
    provider: 'test-provider',
    model: 'test-model',
    source_input_id: 'planner:card:1',
    attempt_index: 0,
    request_params: { temperature: 0 },
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    status: 'ok',
    response_status: 200,
    terminal_tool_fired: null,
    assistant_output_ids: ['planner:card:1:message'],
    ...overrides,
  } as ProviderExchangePayload;
}

function message(payloadValue = payload()) {
  return agentMessageSchema.parse({
    id: `${payloadValue.source_input_id}:provider-exchange:${payloadValue.attempt_index}`,
    session_id: 'planner:card',
    role: 'system',
    kind: 'provider_exchange',
    content: serializeProviderExchangePayload(payloadValue),
    round_id: 'r-assistant-00000000000000000000000000000000',
    message_index: 1,
    block_index: 1,
    timestamp: payloadValue.completed_at,
  });
}

describe('provider_exchange conversation rows', () => {
  it('serializes canonical body-free payloads and excludes rows from model-visible context', () => {
    const projectRoot = root();
    appendProviderExchangeMessage(projectRoot, message());
    const rows = readConversationMessages(projectRoot, 'planner:card');
    expect(rows).toHaveLength(1);
    expect(parseProviderExchangePayload(rows[0].content)).toMatchObject({ source_input_id: 'planner:card:1', assistant_output_ids: ['planner:card:1:message'] });
    expect(rows[0].content).not.toContain('bodyRaw');
    expect(conversationMessagesForModel(rows)).toEqual([]);
  });

  it('skips identical provider_exchange replay and rejects conflicting duplicate ids', () => {
    const projectRoot = root();
    const row = message();
    appendProviderExchangeMessage(projectRoot, row);
    appendProviderExchangeMessage(projectRoot, row);
    expect(readConversationMessages(projectRoot, 'planner:card')).toHaveLength(1);
    expect(() => appendProviderExchangeMessage(projectRoot, { ...row, content: serializeProviderExchangePayload(payload({ response_status: 201 })) })).toThrow(/duplicate id/);
  });
});
