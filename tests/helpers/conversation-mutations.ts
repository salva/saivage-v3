import { ConversationStore } from '../../src/persistence/conversation-store.js';
import { conversationContentDigest } from '../../src/persistence/conversation-store.js';
import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';
import { readFileSync } from 'node:fs';
import type { AgentMessage } from '../../src/schemas/index.js';
import { activeVersionPath } from '../../src/runtime/actors/conversation-inventory.js';
import type { SummaryCacheEntry } from '../../src/runtime/actors/compaction/summary-cache.js';
import { CardStore } from './canonical-project.js';

const stores = new Map<string, ConversationStore>();

export function testConversationMutations(projectRoot: string) {
  const existing = stores.get(projectRoot);
  if (existing) return existing;
  const store = new ConversationStore(projectRoot, new ApplicationPersistenceHealth(), {
    runtimeChanged() {},
    cardStateChanged() {},
    agentsChanged() {},
    conversationChanged() {},
    subscribe() { return { unsubscribe() {} }; },
  }, new CardStore(projectRoot).namespace);
  store.restabilize();
  stores.set(projectRoot, store);
  return store;
}

export function appendTestConversationMessage(projectRoot: string, message: AgentMessage) {
  const result = testConversationMutations(projectRoot).appendBatch([message]);
  return { message: result.messages[0]!, appended: result.appended };
}

export function appendTestSummaryCacheEntry(projectRoot: string, sessionId: string, entry: Omit<SummaryCacheEntry, 'created_at'> & { created_at?: string }): SummaryCacheEntry {
  return testConversationMutations(projectRoot).appendSummaryCacheEntry(sessionId, entry);
}

export function writeTestCompactedConversationVersion(args: { projectRoot: string } & Omit<Parameters<ConversationStore['publishCompactedVersion']>[0], 'sourceDigest'>) {
  const { projectRoot, ...commit } = args;
  const source = readFileSync(activeVersionPath(projectRoot, commit.sessionId, commit.sourceVersion), 'utf8');
  return testConversationMutations(projectRoot).publishCompactedVersion({ ...commit, sourceDigest: conversationContentDigest(source) });
}
