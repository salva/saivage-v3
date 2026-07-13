import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { ReadModelChanges } from '../../src/application/read-model-changes.js';
import { RootCurrentness } from '../../src/application/mutation-authority.js';
import { ConversationStore, conversationContentDigest } from '../../src/persistence/conversation-store.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { activeVersionPath } from '../../src/runtime/actors/conversation-index.js';
import { testMutationComposition } from '../helpers/canonical-project.js';

const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-')); roots.push(value); return value; };
const message = (overrides: Partial<AgentMessage> = {}): AgentMessage => ({ id: 'message-1', session_id: 'planner:project', role: 'assistant', kind: 'text', content: 'hello', round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: '2026-07-13T00:00:00.000Z', ...overrides });
const changes = () => ({ runtimeChanged: jest.fn(), cardStateChanged: jest.fn(), agentsChanged: jest.fn(), conversationChanged: jest.fn(), subscribe: jest.fn() }) as unknown as ReadModelChanges & { agentsChanged: jest.Mock; conversationChanged: jest.Mock };
const store = (projectRoot: string, readModelChanges = changes()) => { const mutation = testMutationComposition(projectRoot); const value = new ConversationStore(projectRoot, mutation.lane, readModelChanges); value.restabilize(mutation.authority); return { value, authority: mutation.authority, changes: readModelChanges }; };

afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('ConversationStore', () => {
  it('atomically appends and idempotently replays a complete batch', () => {
    const projectRoot = root(); const opened = store(projectRoot); const rows = [message(), message({ id: 'message-2', content: 'world', block_index: 1 })];
    expect(opened.value.appendBatch(opened.authority, rows)).toEqual({ messages: rows, appended: true });
    expect(opened.value.appendBatch(opened.authority, rows).appended).toBe(false);
    expect(readFileSync(activeVersionPath(projectRoot, rows[0]!.session_id, 1), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(opened.changes.conversationChanged).toHaveBeenCalledTimes(1);
  });

  it('rejects partial-batch replay and conflicting canonical identity', () => {
    const opened = store(root()); const first = message(); opened.value.appendBatch(opened.authority, [first]);
    expect(() => opened.value.appendBatch(opened.authority, [first, message({ id: 'message-2' })])).toThrow(/partially persisted/);
    expect(() => opened.value.appendBatch(opened.authority, [message({ content: 'changed' })])).toThrow(/conflicts/);
  });

  it('rejects stale exact authority without touching disk', () => {
    const projectRoot = root(); const opened = store(projectRoot); const currentness = new RootCurrentness(); const stale = currentness.installRoot(); currentness.clearRoot(stale);
    expect(() => opened.value.appendBatch(stale, [message()])).toThrow(/stale/);
    expect(() => readFileSync(activeVersionPath(projectRoot, 'planner:project', 1), 'utf8')).toThrow();
  });

  it('commits compaction only against the exact source digest', () => {
    const projectRoot = root(); const opened = store(projectRoot); const row = message(); opened.value.appendBatch(opened.authority, [row]);
    const source = readFileSync(activeVersionPath(projectRoot, row.session_id, 1), 'utf8');
    const commit = { sessionId: row.session_id, sourceVersion: 1, sourceDigest: conversationContentDigest(source), content: `${JSON.stringify(message({ id: 'summary-1', content: 'summary' }))}\n`, compactedThrough: { message_id: row.id, round_id: row.round_id, timestamp: row.timestamp }, summaryIds: ['summary-1'], compactionGeneration: 1, bands: { merge_line: 1, summary_line: 2, trigger: 3, snap: 'compact_straddler' as const } };
    expect(opened.value.replaceActiveVersion(opened.authority, commit).versionReplacement.activeVersion).toBe(2);
    expect(() => opened.value.replaceActiveVersion(opened.authority, commit)).toThrow(/active version changed/);
  });
});
