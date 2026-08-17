import { describe, expect, it } from '@jest/globals';

import {
  canonicalSourceIdentityKey,
  contextBlockContentSha256,
  dynamicBlocksSha256,
  selectLatestContextSnapshots,
  toolCallCompositeIdentityKey,
  validateContextBlock,
  type ContextBlock,
} from '../../../src/runtime/actors/context/index.js';

const block = (id: string, content: string, key?: string): ContextBlock => Object.freeze({
  id,
  role: 'system',
  content,
  storage: 'activation_local',
  replacement: key
    ? Object.freeze({ kind: 'latest_snapshot', key, contentSha256: contextBlockContentSha256(content) })
    : Object.freeze({ kind: 'retain' }),
  audience: 'primary_and_summarizer',
  evidence: Object.freeze({ kind: 'none' }),
  canonicalSource: null,
});

describe('orthogonal context contracts', () => {
  it('selects the last snapshot in composition order without rewriting retained blocks', () => {
    const first = block('first', 'old', 'analyst.project_tree');
    const retained = block('retained', 'always');
    const latest = block('latest', 'new', 'analyst.project_tree');
    expect(selectLatestContextSnapshots([first, retained, latest])).toEqual([retained, latest]);
    expect(first.content).toBe('old');
  });

  it('rejects a represented-content revision mismatch and overlapping alias flags', () => {
    const valid = block('snapshot', 'represented', 'snapshot');
    expect(() => validateContextBlock({
      ...valid,
      replacement: { ...valid.replacement, contentSha256: '0'.repeat(64) } as ContextBlock['replacement'],
    })).toThrow(/contentSha256 mismatch/);
    expect(() => validateContextBlock({ ...valid, visible: true } as ContextBlock)).toThrow(/must contain exactly/);
  });

  it('keeps storage, audience, evidence, and canonical source independent', () => {
    const durable: ContextBlock = {
      id: 'result', role: 'tool', content: '{"success":true}', storage: 'durable',
      replacement: { kind: 'retain' }, audience: 'summarizer_only',
      evidence: { kind: 'observational_query', tool: 'read', arguments: { path: 'project:///x' }, observed_sha256: 'a'.repeat(64) },
      canonicalSource: { kind: 'tool_exchange', sessionId: 'agent:planner:project', sourceInputId: 'input-a', toolCallId: 'call-a' },
    };
    expect(() => validateContextBlock(durable)).not.toThrow();
    expect(dynamicBlocksSha256([durable])).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('uses source-input plus tool-call composite identity and canonical source discriminants', () => {
    expect(toolCallCompositeIdentityKey({ sourceInputId: 'input-a', toolCallId: 'same' }))
      .not.toBe(toolCallCompositeIdentityKey({ sourceInputId: 'input-b', toolCallId: 'same' }));
    expect(canonicalSourceIdentityKey({ kind: 'conversation_message', sessionId: 'agent:planner:project', messageId: 'message-a' }))
      .not.toBe(canonicalSourceIdentityKey({ kind: 'tool_exchange', sessionId: 'agent:planner:project', sourceInputId: 'message-a', toolCallId: 'call-a' }));
  });
});
