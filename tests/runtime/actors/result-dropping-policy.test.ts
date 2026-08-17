import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';

import { buildSummarizerProviderRows, recoverableEvidenceDescriptors } from '../../../src/runtime/actors/compaction/result-dropping.js';
import { agentMessageSchema, canonicalJson, type AgentMessage } from '../../../src/schemas/index.js';
import { testToolCallPolicy, testToolResultPolicy } from '../../helpers/message-context-policy.js';
import type { ToolResultPolicyTemplate } from '../../../src/runtime/actors/llm-invocation.js';

const TEMPLATE: ToolResultPolicyTemplate = Object.freeze({ storage: 'durable', replacement: Object.freeze({ kind: 'retain' }), settledAudience: 'evidence_only', evidenceMode: 'observational_query' });
const SESSION = 'agent:planner:project' as const;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('summarizer result policy correlation', () => {
  it('correlates repeated provider call ids by source input even when settlements are interleaved', () => {
    const callA = call(A, '/a');
    const callB = call(B, '/b');
    const resultA = result(A, { success: true, data: { body: 'A' } }, callA);
    const resultB = result(B, { success: true, data: { body: 'B' } }, callB);
    const rows = [callA, callB, resultB, resultA];

    expect(buildSummarizerProviderRows(rows).slice(2).map((row) => JSON.parse(row.content))).toEqual([
      { evidence: resultB.context_policy.kind === 'tool_result' ? resultB.context_policy.evidence : null, success: true },
      { evidence: resultA.context_policy.kind === 'tool_result' ? resultA.context_policy.evidence : null, success: true },
    ]);
    expect(recoverableEvidenceDescriptors(rows).map((descriptor) => descriptor.flavor === 'observational_query' ? descriptor.args : null)).toEqual([{ path: '/b' }, { path: '/a' }]);
  });
});

function call(sourceInputId: string, path: string): AgentMessage {
  return agentMessageSchema.parse({ id: `${sourceInputId}:tool-call:shared`, session_id: SESSION, role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'shared', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path }) } }] }), context_policy: testToolCallPolicy(TEMPLATE), tool: 'read', tool_call_id: 'shared', round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`, message_index: 1, block_index: 0, timestamp: '2026-08-17T00:00:00.000Z' });
}

function result(sourceInputId: string, providerResult: { success: true; data: unknown }, sourceCall: AgentMessage): AgentMessage {
  if (sourceCall.context_policy.kind !== 'tool_call') throw new Error('missing call policy');
  const content = canonicalJson(providerResult);
  const observedSha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  return agentMessageSchema.parse({ id: `${sourceInputId}:tool-result:shared`, session_id: SESSION, role: 'tool', kind: 'tool_result', content, context_policy: testToolResultPolicy(providerResult, sourceCall.context_policy, 'executed', { kind: 'observational_query', observedSha256 }), tool: 'read', tool_call_id: 'shared', round_id: `r-user-${sourceInputId.replaceAll('-', '')}`, message_index: 2, block_index: 0, timestamp: '2026-08-17T00:00:01.000Z' });
}
