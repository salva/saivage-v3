import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { hashConversationRows } from '../../src/contracts/conversation-compaction.js';
import { appendConversationBatch, readConversation } from '../../src/persistence/conversation-file.js';
import { conversationFile } from '../../src/runtime/actors/conversation-inventory.js';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema, type AgentMessage } from '../../src/schemas/index.js';

describe('conversation compaction file persistence', () => {
  it('round-trips one strict current-format envelope and validates prospective appends', () => withRoot((root) => {
    const source = activation();
    appendConversationBatch(root, [source]);
    const valid = metadata('c1', hashConversationRows([source]));
    appendConversationBatch(root, [valid]);
    expect(readConversation(root, 'planner:project').latestCompaction!.cutoffMessageId).toBe(source.id);

    expect(() => appendConversationBatch(root, [metadata('c2', '0'.repeat(64))])).toThrow(/hash mismatch/);
    expect(readConversation(root, 'planner:project').compactions).toHaveLength(1);
  }));

  it('rejects a complete old-format envelope rather than normalizing it', () => withRoot((root) => {
    const path = conversationFile(root, 'planner:project');
    mkdirSync(dirname(path), { recursive: true });
    const old = { ...metadata('old', '0'.repeat(64)), content: canonicalJson({ cutoff: { round_id: 'activation', through_message_id: 'activation', boundary: 'round' }, retained_static_message_ids: [], merged_history: null, individual_rounds: [], round_coverage: [], rendered_context: 'old', applied_policy: policy() }) };
    writeFileSync(path, `${JSON.stringify({ version: 1, type: 'rows', rows: [old] })}\n`);
    expect(() => readConversation(root, 'planner:project')).toThrow(/malformed|invalid/i);
  }));

  it('rejects a complete pre-cutover policy row containing a removed derived field', () => withRoot((root) => {
    const path = conversationFile(root, 'planner:project');
    mkdirSync(dirname(path), { recursive: true });
    const source = activation();
    const current = metadata('old-policy', hashConversationRows([source]));
    const payload = JSON.parse(current.content) as Record<string, unknown> & { applied_policy: Record<string, unknown> };
    payload.applied_policy.requested_completion_tokens = 200;
    const oldPolicy = { ...current, content: canonicalJson(payload) };
    writeFileSync(path, `${JSON.stringify({ version: 1, type: 'rows', rows: [source, oldPolicy] })}\n`);
    expect(() => readConversation(root, 'planner:project')).toThrow(/unrecognized key|malformed|invalid/i);
  }));

  it('keeps the existing identifiable unterminated-final-suffix handling', () => withRoot((root) => {
    appendConversationBatch(root, [activation()]);
    const path = conversationFile(root, 'planner:project');
    appendFileSync(path, '{"incomplete":');
    expect(readConversation(root, 'planner:project').sourceRows).toHaveLength(1);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  }));
});

function activation(): AgentMessage {
  return agentMessageSchema.parse({ id: 'activation', session_id: 'planner:project', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open' }), round_id: 'r-pre-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-16T00:00:00.000Z' });
}

function metadata(id: string, hash: string): AgentMessage {
  const payload = contextCompactionContentSchema.parse({ boundary: 'round', retained_static_message_ids: [], summaries: [{ kind: 'individual', rounds: [{ complete: true, segments: [{ kind: 'initial', source_message_ids: ['activation'] }] }], content_hash: hash, summary_text: 'summary', evidence: [] }], applied_policy: policy() });
  return agentMessageSchema.parse({ id, session_id: 'planner:project', role: 'system', kind: 'context_compaction', content: canonicalJson(payload), round_id: 'r-compacted-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-16T00:01:00.000Z' });
}

function policy() {
  return { mode: 'normal', band: 'normal', input_budget_tokens: 1000, canonical_estimated_static_tokens: 10, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, snap: 'compact_straddler' } as const;
}

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'saivage-compaction-file-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
