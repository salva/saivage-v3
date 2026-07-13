import { ConversationStore } from '../../src/persistence/conversation-store.js';
import { conversationContentDigest } from '../../src/persistence/conversation-store.js';
import { createMutationLane } from '../../src/application/mutation-lane.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentMessage } from '../../src/schemas/index.js';
import { activeVersionPath, conversationIndexPath, readConversationIndex, type ConversationIndex } from '../../src/runtime/actors/conversation-index.js';
import type { SummaryCacheEntry } from '../../src/runtime/actors/compaction/summary-cache.js';

const stores = new Map<string, { store: ConversationStore; authority: import('../../src/application/mutation-authority.js').CompositionMutationAuthority }>();

export function testConversationMutations(projectRoot: string) {
  const existing = stores.get(projectRoot);
  if (existing) return existing.store;
  const mutation = createMutationLane();
  const store = new ConversationStore(projectRoot, mutation.lane, {
    runtimeChanged() {},
    cardStateChanged() {},
    agentsChanged() {},
    conversationChanged() {},
    subscribe() { return { unsubscribe() {} }; },
  });
  store.restabilize(mutation.authority);
  stores.set(projectRoot, { store, authority: mutation.authority });
  return store;
}

export function testConversationAuthority(projectRoot: string) {
  testConversationMutations(projectRoot);
  return stores.get(projectRoot)!.authority;
}

export function appendTestConversationMessage(projectRoot: string, message: AgentMessage) {
  const result = testConversationMutations(projectRoot).appendBatch(testConversationAuthority(projectRoot), [message]);
  return { message: result.messages[0]!, appended: result.appended };
}

export function writeTestConversationIndex(projectRoot: string, sessionId: string, index: ConversationIndex): void {
  const path = conversationIndexPath(projectRoot, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);
}

export function ensureTestConversationIndex(projectRoot: string, sessionId: string): ConversationIndex {
  const existing = readConversationIndex(projectRoot, sessionId);
  if (existing) return existing;
  const index: ConversationIndex = { schema_version: 2, session_id: sessionId, active_version: 1, versions: { '1': { status: 'active', opened_at: new Date().toISOString() } } };
  const versionPath = activeVersionPath(projectRoot, sessionId, 1);
  mkdirSync(dirname(versionPath), { recursive: true });
  writeFileSync(versionPath, '');
  writeTestConversationIndex(projectRoot, sessionId, index);
  return index;
}

export function appendTestSummaryCacheEntry(projectRoot: string, sessionId: string, entry: Omit<SummaryCacheEntry, 'created_at'> & { created_at?: string }): SummaryCacheEntry {
  return testConversationMutations(projectRoot).appendSummaryCacheEntry(testConversationAuthority(projectRoot), sessionId, entry);
}

export function writeTestCompactedConversationVersion(args: { projectRoot: string } & Omit<Parameters<ConversationStore['replaceActiveVersion']>[1], 'sourceDigest'>) {
  const { projectRoot, ...commit } = args;
  const source = readFileSync(activeVersionPath(projectRoot, commit.sessionId, commit.sourceVersion), 'utf8');
  return testConversationMutations(projectRoot).replaceActiveVersion(testConversationAuthority(projectRoot), { ...commit, sourceDigest: conversationContentDigest(source) });
}
