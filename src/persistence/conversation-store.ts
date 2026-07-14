import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ApplicationPersistenceHealth } from '../application/persistence-health.js';
import type { ReadModelChanges } from '../application/read-model-changes.js';
import type { ProjectNamespaceReader } from './project-store-repository.js';
import { cleanupDurableReplacementTemporaries, publishDirectory } from './durable-file-replacement.js';
import { IndeterminatePublicationError } from './errors.js';
import { appendEnvelope, parseGrowingFile, publishFirstEnvelope, serializeGrowingEnvelope } from './growing-file.js';
import { discardIncompleteJsonlTail } from './store-restabilization.js';
import { agentMessageSchema, type AgentMessage } from '../schemas/index.js';
import {
  activeVersionPath,
  conversationDir,
  parseConversationSessionId,
  readConversationInventory,
  type ConversationInventory,
  type ConversationVersionReplacement,
} from '../runtime/actors/conversation-inventory.js';
import { listConversationSessionIds, readConversationVersionMessages } from '../runtime/actors/conversation-store.js';
import { summaryCacheEntrySchema, summaryCachePath, type SummaryCacheEntry } from '../runtime/actors/compaction/summary-cache.js';

export interface ConversationCompactionSnapshot {
  sessionId: string;
  messages: readonly AgentMessage[];
  compactedThrough: { message_id: string; round_id: string; timestamp: string };
  summaryIds: string[];
  compactionGeneration: number;
  bands: { merge_line: number; summary_line: number; trigger: number; snap: 'keep_straddler_verbatim' | 'compact_straddler' };
}

export class ConversationStore {
  readonly #inventories = new Map<string, ConversationInventory>();
  readonly #activeMessageIds = new Map<string, Set<string>>();
  readonly #summaryKeys = new Map<string, Set<string>>();
  readonly #publishedSummarySessions = new Set<string>();
  #loaded = false;

  constructor(
    readonly projectRoot: string,
    private readonly health: ApplicationPersistenceHealth,
    private readonly changes: ReadModelChanges,
    readonly namespace: ProjectNamespaceReader,
  ) {}

  restabilize(): void {
    this.#inventories.clear();
    this.#activeMessageIds.clear();
    this.#summaryKeys.clear();
    this.#publishedSummarySessions.clear();
    for (const sessionId of listConversationSessionIds(this.projectRoot, this.namespace)) {
      const inventory = this.restabilizeSession(sessionId);
      if (inventory) this.#inventories.set(sessionId, inventory);
    }
    this.#loaded = true;
  }

  appendBatch(messages: readonly AgentMessage[]): void {
    this.health.assertMutationHealthy();
    if (!this.#loaded) throw new Error('Conversations have not been loaded.');
    if (messages.length === 0) throw new Error('Conversation appendBatch requires at least one message.');
    const parsed = messages.map((message) => agentMessageSchema.parse(message));
    const sessionId = parsed[0]!.session_id;
    if (parsed.some((message) => message.session_id !== sessionId)) throw new Error('Conversation appendBatch requires one session.');
    if (new Set(parsed.map((message) => message.id)).size !== parsed.length) throw new Error('Conversation appendBatch contains duplicate message ids.');

    try {
      const parsedSession = parseConversationSessionId(sessionId);
      if (parsedSession.cardId !== null && !this.namespace.isActiveCardId(parsedSession.cardId)) throw new Error(`Card '${parsedSession.cardId}' not found.`);
      const inventory = this.#inventories.get(sessionId);
      if (!inventory) {
        const directory = conversationDir(this.projectRoot, sessionId);
        mkdirSync(dirname(directory), { recursive: true });
        publishDirectory(directory);
        const target = activeVersionPath(this.projectRoot, sessionId, 1);
        publishFirstEnvelope(target, serializeGrowingEnvelope(parsed, agentMessageSchema), this.health, 'publish first conversation envelope');
        this.#inventories.set(sessionId, Object.freeze({ sessionId, versions: Object.freeze([1]), activeVersion: 1 }));
        this.#activeMessageIds.set(sessionId, new Set(parsed.map((message) => message.id)));
        this.#summaryKeys.set(sessionId, new Set());
      } else {
        const activePath = activeVersionPath(this.projectRoot, sessionId, inventory.activeVersion);
        const ids = this.#activeMessageIds.get(sessionId)!;
        const duplicate = parsed.find((message) => ids.has(message.id));
        if (duplicate) throw new Error(`Conversation message '${duplicate.id}' already exists in active version ${inventory.activeVersion}.`);
        appendEnvelope(activePath, serializeGrowingEnvelope(parsed, agentMessageSchema), this.health, 'append conversation envelope');
        for (const message of parsed) ids.add(message.id);
      }
    } catch (error) {
      if (error instanceof IndeterminatePublicationError) this.health.reportUncertainFailure({ target: conversationDir(this.projectRoot, sessionId), operation: 'append conversation batch', error });
      throw error;
    }
    this.changes.conversationChanged(sessionId);
    this.changes.agentsChanged();
  }

  activeVersionMessages(sessionId: string): Readonly<{ version: number; messages: readonly AgentMessage[] }> {
    if (!this.#loaded) throw new Error('Conversations have not been loaded.');
    const inventory = this.#inventories.get(sessionId);
    if (!inventory) throw new Error(`Conversation '${sessionId}' does not exist.`);
    return Object.freeze({ version: inventory.activeVersion, messages: Object.freeze(readConversationVersionMessages(activeVersionPath(this.projectRoot, sessionId, inventory.activeVersion))) });
  }

  publishCompactedVersion(args: ConversationCompactionSnapshot): ConversationVersionReplacement {
    this.health.assertMutationHealthy();
    const parsedSession = parseConversationSessionId(args.sessionId);
    if (parsedSession.cardId !== null && !this.namespace.isActiveCardId(parsedSession.cardId)) throw new Error(`Card '${parsedSession.cardId}' not found.`);
    if (!this.#loaded) throw new Error('Conversations have not been loaded.');
    const inventory = this.#inventories.get(args.sessionId);
    if (!inventory) throw new Error(`Conversation '${args.sessionId}' does not exist.`);
    const messages = args.messages.map((message) => agentMessageSchema.parse(message));
    if (messages.length === 0) throw new Error('Compacted conversation version must contain at least one message.');
    if (new Set(messages.map((message) => message.id)).size !== messages.length) throw new Error('Compacted conversation version contains duplicate message ids.');

    const nextVersion = inventory.activeVersion + 1;
    try {
      const target = activeVersionPath(this.projectRoot, args.sessionId, nextVersion);
      publishFirstEnvelope(target, serializeGrowingEnvelope(messages, agentMessageSchema), this.health, 'publish compacted conversation version');
    } catch (error) {
      if (error instanceof IndeterminatePublicationError) this.health.reportUncertainFailure({ target: activeVersionPath(this.projectRoot, args.sessionId, nextVersion), operation: 'publish compacted conversation version', error });
      throw error;
    }
    this.#inventories.set(args.sessionId, Object.freeze({ sessionId: args.sessionId, versions: Object.freeze([...inventory.versions, nextVersion]), activeVersion: nextVersion }));
    this.#activeMessageIds.set(args.sessionId, new Set(messages.map((message) => message.id)));
    this.changes.conversationChanged(args.sessionId);
    this.changes.agentsChanged();
    return { sessionId: args.sessionId, activeVersion: nextVersion, compactedThrough: args.compactedThrough, compactionGeneration: args.compactionGeneration };
  }

  appendSummaryCacheEntry(sessionId: string, entry: Omit<SummaryCacheEntry, 'created_at'> & { created_at?: string }): SummaryCacheEntry {
    this.health.assertMutationHealthy();
    if (!this.#loaded) throw new Error('Conversations have not been loaded.');
    if (!this.#inventories.has(sessionId)) throw new Error(`Conversation '${sessionId}' does not exist.`);
    const parsed = summaryCacheEntrySchema.parse({ ...entry, created_at: entry.created_at ?? new Date().toISOString() });
    const keys = this.#summaryKeys.get(sessionId) ?? new Set<string>();
    if (keys.has(parsed.cache_key)) throw new Error(`Summary cache entry '${parsed.cache_key}' already exists.`);
    const path = summaryCachePath(this.projectRoot, sessionId);
    const bytes = serializeGrowingEnvelope([parsed], summaryCacheEntrySchema);
    if (this.#publishedSummarySessions.has(sessionId)) appendEnvelope(path, bytes, this.health, 'append conversation summary cache');
    else publishFirstEnvelope(path, bytes, this.health, 'publish first conversation summary cache envelope');
    keys.add(parsed.cache_key);
    this.#summaryKeys.set(sessionId, keys);
    this.#publishedSummarySessions.add(sessionId);
    return parsed;
  }

  private restabilizeSession(sessionId: string): ConversationInventory | null {
    const directory = conversationDir(this.projectRoot, sessionId);
    const targets = new Set<string>(['summaries.jsonl']);
    for (const entry of readdirSync(directory)) {
      if (/^[1-9][0-9]*\.jsonl$/.test(entry)) targets.add(entry);
      const match = /^\.(summaries\.jsonl|[1-9][0-9]*\.jsonl)\.saivage-write-[0-9a-f-]+\.tmp$/.exec(entry);
      if (match?.[1]) targets.add(match[1]);
    }
    cleanupDurableReplacementTemporaries(directory, [...targets]);
    if (readdirSync(directory).length === 0) {
      rmdirSync(directory);
      syncDirectory(dirname(directory));
      return null;
    }
    const inventory = readConversationInventory(this.projectRoot, sessionId);
    if (!inventory) throw new Error(`Conversation '${sessionId}' has no published version.`);
    let activeMessages: AgentMessage[] = [];
    for (const version of inventory.versions) {
      const path = join(directory, `${version}.jsonl`);
      discardIncompleteJsonlTail(path);
      const messages = readConversationVersionMessages(path);
      if (version === inventory.activeVersion) activeMessages = messages;
    }
    this.#activeMessageIds.set(sessionId, new Set(activeMessages.map((message) => message.id)));
    const summaryPath = summaryCachePath(this.projectRoot, sessionId);
    if (existsSync(summaryPath)) discardIncompleteJsonlTail(summaryPath);
    const summaries = readSummaryCacheStrict(summaryPath);
    if (existsSync(summaryPath)) this.#publishedSummarySessions.add(sessionId);
    const keys = new Set<string>();
    for (const summary of summaries) {
      if (keys.has(summary.cache_key)) throw new Error(`Summary cache '${summaryPath}' contains duplicate key '${summary.cache_key}'.`);
      keys.add(summary.cache_key);
    }
    this.#summaryKeys.set(sessionId, keys);
    return inventory;
  }
}

function readSummaryCacheStrict(path: string): SummaryCacheEntry[] {
  if (!existsSync(path)) return [];
  return parseGrowingFile(path, readFileSync(path, 'utf8'), summaryCacheEntrySchema);
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
