import { describe, expect, it, jest } from '@jest/globals';

import {
  AgentConversationResponseSchema,
  AgentDetailResponseSchema,
  AgentListResponseSchema,
  AgentLlmExchangeResponseSchema,
} from '../../src/contracts/operator-api-agents.js';
import { buildAgentOperatorContractHandlers } from '../../src/server/routes/operator-agent-handlers.js';

const invalid = ['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'] as const;
const timestamp = '2026-07-17T00:00:00.000Z';

describe('operator Agent exact identity contracts and handlers', () => {
  const variants: Array<[string, string, string | null]> = [
    ['analyst:global', 'analyst', null],
    ['planner:project', 'planner', 'project'],
    ['reviewer:project', 'reviewer', 'project'],
    ['executor:card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'executor', 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  ];
  it.each(variants)('parses correlated success variants for %s', (id, role, cardId) => {
    const session = { id, role, card_id: cardId, status: 'inactive', started_at: timestamp };
    expect(AgentListResponseSchema.parse({ sessions: [session] }).sessions[0]!.id).toBe(id);
    expect(AgentDetailResponseSchema.parse({ session: { ...session, message_count: 1, last_activity_at: timestamp } }).session.id).toBe(id);
    expect(AgentConversationResponseSchema.parse({ session, entries: [entry(id)], activity_status: { status: 'inactive', pending_calls: [] } }).session.id).toBe(id);
    expect(AgentLlmExchangeResponseSchema.parse({ sessionId: id, exchange: exchange() }).sessionId).toBe(id);
  });

  it('rejects role, card ownership, entry, and LLM identity mismatches', () => {
    expect(AgentListResponseSchema.safeParse({ sessions: [{ id: 'planner:project', role: 'reviewer', card_id: 'project', status: 'inactive', started_at: timestamp }] }).success).toBe(false);
    expect(AgentListResponseSchema.safeParse({ sessions: [{ id: 'planner:project', role: 'planner', card_id: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'inactive', started_at: timestamp }] }).success).toBe(false);
    expect(AgentConversationResponseSchema.safeParse({ session: { id: 'planner:project', role: 'planner', card_id: 'project', status: 'inactive', started_at: timestamp }, entries: [entry('reviewer:project')], activity_status: { status: 'inactive', pending_calls: [] } }).success).toBe(false);
    expect(AgentLlmExchangeResponseSchema.safeParse({ sessionId: 'analyst:test', exchange: exchange() }).success).toBe(false);
  });

  it.each(invalid)('rejects every ID-bearing route before card reads for %s', async (id) => {
    const read = jest.fn(() => { throw new Error('must not read'); });
    const handlers = buildAgentOperatorContractHandlers({ projectRoot: '/nonexistent', cardStore: { read }, runtimeApplication: { captureExecutingLlmSnapshots: () => [] } } as never);
    const request = { log: { error: jest.fn() } };
    expect(await handlers['agents.detail']!({ params: { id }, request } as never)).toMatchObject({ statusCode: 400 });
    expect(await handlers['agents.conversation']!({ params: { id }, request } as never)).toMatchObject({ statusCode: 400 });
    expect(await handlers['agents.llmExchange']!({ params: { id }, request } as never)).toMatchObject({ statusCode: 400 });
    expect(read).not.toHaveBeenCalled();
  });
});

function entry(session_id: string) {
  return { id: 'm1', session_id, role: 'user', kind: 'text', content: 'hello', round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message_index: 0, block_index: 0, timestamp };
}

function exchange() {
  return { contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model: 'model', source_input_id: 'input', attempt_index: 0, request_params: {}, started_at: timestamp, completed_at: timestamp, status: 'ok', terminal_tool_fired: null, assistant_output_ids: [] };
}
