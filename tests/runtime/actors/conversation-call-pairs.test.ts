import { describe, expect, it } from '@jest/globals';
import { inspectCanonicalCallSettlementPairs } from '../../../src/runtime/actors/conversation-call-pairs.js';
import type { AgentMessage, ConversationSessionId } from '../../../src/schemas/index.js';

const timestamp = '2026-07-18T00:00:00.000Z';
const source = '11111111-1111-4111-8111-111111111111';
const round = `r-assistant-${source.replaceAll('-', '')}`;

function call(overrides: Partial<AgentMessage> = {}): AgentMessage {
  const session_id = (overrides.session_id ?? 'agent:planner:project') as ConversationSessionId;
  const tool_call_id = overrides.tool_call_id ?? 'call-1';
  const tool = overrides.tool ?? 'webfetch';
  return { id: `${source}:tool-call:${tool_call_id}`, session_id, role: 'assistant', kind: 'tool_call', tool, tool_call_id, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: tool_call_id, type: 'function', function: { name: tool, arguments: '{"url":"https://example.com"}' } }] }), round_id: round, message_index: 0, block_index: 0, timestamp, ...overrides };
}

function result(overrides: Partial<AgentMessage> = {}): AgentMessage {
  const tool_call_id = overrides.tool_call_id ?? 'call-1';
  return { id: `${source}:tool-result:${tool_call_id}`, session_id: 'agent:planner:project', role: 'tool', kind: 'tool_result', tool: 'webfetch', tool_call_id, content: '{"success":true}', round_id: round, message_index: 1, block_index: 0, timestamp, ...overrides };
}

describe('canonical conversation call-pair inspection', () => {
  it('projects exact canonical calls and unmatched calls', () => {
    const row = call();
    expect(inspectCanonicalCallSettlementPairs([row])).toMatchObject({ calls: [{ message: row, index: 0 }], unmatched: [{ toolCallId: 'call-1' }] });
    expect(inspectCanonicalCallSettlementPairs([row, result()]).unmatched).toEqual([]);
  });

  it('rejects duplicate calls, result-before-call, and duplicate results', () => {
    expect(() => inspectCanonicalCallSettlementPairs([call(), call()])).toThrow('Duplicate tool call identity');
    expect(() => inspectCanonicalCallSettlementPairs([result(), call()])).toThrow('has no prior matching call');
    expect(() => inspectCanonicalCallSettlementPairs([call(), result(), result()])).toThrow('duplicate settlements');
  });

  it('rejects source and session identity mismatches', () => {
    expect(() => inspectCanonicalCallSettlementPairs([call(), result({ id: `22222222-2222-4222-8222-222222222222:tool-result:call-1` })])).toThrow('has no prior matching call');
    expect(() => inspectCanonicalCallSettlementPairs([call(), result({ session_id: 'agent:reviewer:project' })])).toThrow('has no prior matching call');
  });
});
