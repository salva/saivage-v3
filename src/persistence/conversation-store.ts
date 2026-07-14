import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ApplicationPersistenceHealth } from '../application/persistence-health.js';
import type { ReadModelChanges } from '../application/read-model-changes.js';
import type { ProjectNamespaceReader } from './project-store-repository.js';
import { cleanupDurableReplacementTemporaries, durablyReplaceFile } from './durable-file-replacement.js';
import { IndeterminatePublicationError } from './errors.js';
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

export type ConversationAppendResult = { message: AgentMessage; appended: boolean };
export type ConversationBatchAppendResult = { messages: AgentMessage[]; appended: boolean };

export interface ConversationCompactionCommit {
  sessionId: string;
  sourceVersion: number;
  sourceDigest: string;
  content: string;
  compactedThrough: { message_id: string; round_id: string; timestamp: string };
  summaryIds: string[];
  compactionGeneration: number;
  bands: { merge_line: number; summary_line: number; trigger: number; snap: 'keep_straddler_verbatim' | 'compact_straddler' };
}

export function conversationContentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class ConversationStore {
  constructor(
    readonly projectRoot: string,
    private readonly health: ApplicationPersistenceHealth,
    private readonly changes: ReadModelChanges,
    readonly namespace: ProjectNamespaceReader,
  ) {}

  restabilize(): void {
    for (const sessionId of listConversationSessionIds(this.projectRoot, this.namespace)) this.restabilizeSession(sessionId);
  }

  appendBatch(messages: readonly AgentMessage[]): ConversationBatchAppendResult {
    this.health.assertMutationHealthy();
    if (messages.length === 0) throw new Error('Conversation appendBatch requires at least one message.');
    const parsed = messages.map((message) => agentMessageSchema.parse(message));
    const sessionId = parsed[0]!.session_id;
    if (parsed.some((message) => message.session_id !== sessionId)) throw new Error('Conversation appendBatch requires one session.');
    if (new Set(parsed.map((message) => message.id)).size !== parsed.length) throw new Error('Conversation appendBatch contains duplicate message ids.');

    let outcome: ConversationBatchAppendResult;
    try {
      const parsedSession = parseConversationSessionId(sessionId);
      if (parsedSession.cardId !== null && !this.namespace.isActiveCardId(parsedSession.cardId)) throw new Error(`Card '${parsedSession.cardId}' not found.`);
      const inventory = readConversationInventory(this.projectRoot, sessionId);
      if (!inventory) {
        mkdirSync(conversationDir(this.projectRoot, sessionId), { recursive: true });
        this.replace(activeVersionPath(this.projectRoot, sessionId, 1), serializeMessages(parsed));
        outcome = { messages: parsed, appended: true };
      } else {
        const existing = this.messagesById(sessionId, inventory);
        const matchedRows = parsed.map((message) => {
          const rows = existing.get(message.id) ?? [];
          if (rows.some((row) => comparableMessage(row) !== comparableMessage(message))) throw new Error(`Conversation message '${message.id}' conflicts with indexed canonical content.`);
          return rows[0];
        });
        if (matchedRows.every((row) => row !== undefined)) {
          outcome = { messages: matchedRows as AgentMessage[], appended: false };
        } else {
          if (matchedRows.some((row) => row !== undefined)) throw new Error('Conversation appendBatch conflicts with a partially persisted batch.');
          const activePath = activeVersionPath(this.projectRoot, sessionId, inventory.activeVersion);
          const prior = readStrictConversationContent(activePath);
          this.replace(activePath, `${prior}${serializeMessages(parsed)}`);
          outcome = { messages: parsed, appended: true };
        }
      }
    } catch (error) {
      if (error instanceof IndeterminatePublicationError) this.health.reportUncertainFailure({ target: conversationDir(this.projectRoot, sessionId), operation: 'append conversation batch', error });
      throw error;
    }
    if (outcome.appended) {
      this.changes.conversationChanged(sessionId);
      this.changes.agentsChanged();
    }
    return outcome;
  }

  publishCompactedVersion(args: ConversationCompactionCommit): ConversationVersionReplacement {
    this.health.assertMutationHealthy();
    const parsedSession = parseConversationSessionId(args.sessionId);
    if (parsedSession.cardId !== null && !this.namespace.isActiveCardId(parsedSession.cardId)) throw new Error(`Card '${parsedSession.cardId}' not found.`);
    const inventory = readConversationInventory(this.projectRoot, args.sessionId);
    if (!inventory) throw new Error(`Conversation '${args.sessionId}' does not exist.`);
    if (inventory.activeVersion !== args.sourceVersion) throw new Error(`Conversation '${args.sessionId}' active version changed from ${args.sourceVersion} to ${inventory.activeVersion} during compaction.`);
    const sourcePath = activeVersionPath(this.projectRoot, args.sessionId, args.sourceVersion);
    const sourceContent = readStrictConversationContent(sourcePath);
    if (conversationContentDigest(sourceContent) !== args.sourceDigest) throw new Error(`Conversation '${args.sessionId}' changed during compaction.`);
    for (const line of args.content.split('\n').filter(Boolean)) agentMessageSchema.parse(JSON.parse(line));

    const nextVersion = inventory.activeVersion + 1;
    try {
      this.replace(activeVersionPath(this.projectRoot, args.sessionId, nextVersion), args.content);
    } catch (error) {
      if (error instanceof IndeterminatePublicationError) this.health.reportUncertainFailure({ target: activeVersionPath(this.projectRoot, args.sessionId, nextVersion), operation: 'publish compacted conversation version', error });
      throw error;
    }
    this.changes.conversationChanged(args.sessionId);
    this.changes.agentsChanged();
    return { sessionId: args.sessionId, activeVersion: nextVersion, compactedThrough: args.compactedThrough, compactionGeneration: args.compactionGeneration };
  }

  appendSummaryCacheEntry(sessionId: string, entry: Omit<SummaryCacheEntry, 'created_at'> & { created_at?: string }): SummaryCacheEntry {
    this.health.assertMutationHealthy();
    const parsed = summaryCacheEntrySchema.parse({ ...entry, created_at: entry.created_at ?? new Date().toISOString() });
      const path = summaryCachePath(this.projectRoot, sessionId);
      const current = readSummaryCacheStrict(path);
      const existing = current.find((item) => item.cache_key === parsed.cache_key);
      if (existing) {
        if (canonicalSummary(existing) !== canonicalSummary(parsed)) throw new Error(`Summary cache entry '${parsed.cache_key}' already exists and is immutable.`);
        return existing;
      }
      try { this.replace(path, serializeSummaryCache([...current, parsed])); }
      catch (error) { if (error instanceof IndeterminatePublicationError) this.health.reportUncertainFailure({ target: path, operation: 'append conversation summary cache', error }); throw error; }
      return parsed;
  }

  private replace(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    durablyReplaceFile(path, Buffer.from(content));
  }

  private messagesById(sessionId: string, inventory: ConversationInventory): Map<string, AgentMessage[]> {
    const messages = new Map<string, AgentMessage[]>();
    for (const version of inventory.versions) {
      const path = activeVersionPath(this.projectRoot, sessionId, version);
      if (!existsSync(path)) throw new Error(`Conversation version '${path}' was not found.`);
      for (const message of readConversationVersionMessages(path)) {
        const rows = messages.get(message.id) ?? [];
        rows.push(message);
        messages.set(message.id, rows);
      }
    }
    return messages;
  }

  private restabilizeSession(sessionId: string): void {
    const directory = conversationDir(this.projectRoot, sessionId);
    const targets = new Set<string>(['summaries.jsonl']);
    for (const entry of readdirSync(directory)) {
      if (/^[1-9][0-9]*\.jsonl$/.test(entry)) targets.add(entry);
      const match = /^\.(summaries\.jsonl|[1-9][0-9]*\.jsonl)\.saivage-write-[0-9a-f-]+\.tmp$/.exec(entry);
      if (match?.[1]) targets.add(match[1]);
    }
    cleanupDurableReplacementTemporaries(directory, [...targets]);
    const inventory = readConversationInventory(this.projectRoot, sessionId);
    if (!inventory) throw new Error(`Conversation '${sessionId}' has no published version.`);
    for (const version of inventory.versions) readConversationVersionMessages(join(directory, `${version}.jsonl`));
    readSummaryCacheStrict(summaryCachePath(this.projectRoot, sessionId));
  }
}

function serializeMessages(messages: readonly AgentMessage[]): string {
  return messages.map((message) => JSON.stringify(agentMessageSchema.parse(message))).join('\n') + '\n';
}

function comparableMessage(message: AgentMessage): string { const { timestamp: _timestamp, ...rest } = agentMessageSchema.parse(message); return JSON.stringify(rest); }
function canonicalSummary(entry: SummaryCacheEntry): string { const { created_at: _createdAt, ...rest } = entry; return JSON.stringify(rest); }
function serializeSummaryCache(entries: readonly SummaryCacheEntry[]): string { return entries.length === 0 ? '' : `${entries.map((entry) => JSON.stringify(summaryCacheEntrySchema.parse(entry))).join('\n')}\n`; }

function readStrictConversationContent(path: string): string {
  if (!existsSync(path)) throw new Error(`Conversation version '${path}' was not found.`);
  const content = readFileSync(path, 'utf8');
  if (content.length > 0 && !content.endsWith('\n')) throw new Error(`Conversation version '${path}' has an incomplete final row.`);
  for (const line of content.split('\n').filter(Boolean)) agentMessageSchema.parse(JSON.parse(line));
  return content;
}

function readSummaryCacheStrict(path: string): SummaryCacheEntry[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  if (content.length > 0 && !content.endsWith('\n')) throw new Error(`Summary cache '${path}' has an incomplete final row.`);
  return content.split('\n').filter(Boolean).map((line) => summaryCacheEntrySchema.parse(JSON.parse(line)));
}
