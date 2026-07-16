import { describe, expect, it } from '@jest/globals';
import { sourceInputIdFromToolResultMessageId } from '../../src/schemas/message-identity.js';
import { agentMessageSchema } from '../../src/schemas/index.js';

const source = '11111111-1111-4111-8111-111111111111';

describe('tool settlement identity', () => {
  it('uses only the original call source UUID and provider tool call id', () => {
    expect(sourceInputIdFromToolResultMessageId(`${source}:tool-result:call-1`, 'call-1')).toBe(source);
    expect(agentMessageSchema.parse({ id: `${source}:tool-result:call-1`, session_id: 'planner:project', role: 'tool', kind: 'tool_result', content: '{"success":true}', tool: 'emit_result', tool_call_id: 'call-1', round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message_index: 2, block_index: 0, timestamp: '2026-07-15T00:00:00.000Z' }).id).toBe(`${source}:tool-result:call-1`);
  });

  it('rejects delivery segments and non-UUID source identities', () => {
    expect(() => agentMessageSchema.parse({ id: `${source}:tool:1:tool-result:call-1`, session_id: 'planner:project', role: 'tool', kind: 'tool_result', content: '{}', tool: 'emit_result', tool_call_id: 'call-1', round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message_index: 2, block_index: 0, timestamp: '2026-07-15T00:00:00.000Z' })).toThrow();
    expect(() => agentMessageSchema.parse({ id: 'planner:project:1:tool-result:call-1', session_id: 'planner:project', role: 'tool', kind: 'tool_result', content: '{}', tool: 'emit_result', tool_call_id: 'call-1', round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message_index: 2, block_index: 0, timestamp: '2026-07-15T00:00:00.000Z' })).toThrow();
  });
});
