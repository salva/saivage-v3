import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { CompositionMutationAuthority, MutationAuthority } from '../application/mutation-authority.js';
import type { MutationLane } from '../application/mutation-lane.js';
import type { ReadModelChanges } from '../application/read-model-changes.js';
import { cleanupDurableReplacementTemporaries, durablyReplaceFile } from './durable-file-replacement.js';
import { IndeterminatePublicationError } from './errors.js';
import { agentMessageSchema, type AgentMessage } from '../schemas/index.js';
import {
  activeVersionPath,
  conversationDir,
  conversationIndexPath,
  conversationIndexSchema,
  readValidatedConversationIndex,
  type ConversationIndex,
  type ConversationVersionReplacement,
} from '../runtime/actors/conversation-index.js';
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
  #failed = false;

  constructor(
    readonly projectRoot: string,
    private readonly lane: MutationLane,
    private readonly changes: ReadModelChanges,
  ) {}

  restabilize(authority: CompositionMutationAuthority): void {
    const result = this.lane.apply(authority, 'conversation store restabilization', () => {
      for (const sessionId of listConversationSessionIds(this.projectRoot)) this.restabilizeSession(sessionId);
    });
    if (!result.applied) throw new Error('Composition authority unexpectedly became stale.');
  }

  appendBatch(authority: MutationAuthority, messages: readonly AgentMessage[]): ConversationBatchAppendResult {
    if (this.#failed) throw new Error('Conversation store has failed and requires restart.');
    if (messages.length === 0) throw new Error('Conversation appendBatch requires at least one message.');
    const parsed = messages.map((message) => agentMessageSchema.parse(message));
    const sessionId = parsed[0]!.session_id;
    if (parsed.some((message) => message.session_id !== sessionId)) throw new Error('Conversation appendBatch requires one session.');
    if (new Set(parsed.map((message) => message.id)).size !== parsed.length) throw new Error('Conversation appendBatch contains duplicate message ids.');

    const result = this.lane.apply(authority, 'conversation batch append', () => {
      try {
        const index = readValidatedConversationIndex(this.projectRoot, sessionId);
        if (!index) {
          const now = new Date().toISOString();
          const initial: ConversationIndex = { schema_version: 2, session_id: sessionId, active_version: 1, versions: { '1': { status: 'active', opened_at: now } } };
          mkdirSync(conversationDir(this.projectRoot, sessionId), { recursive: true });
          this.replace(activeVersionPath(this.projectRoot, sessionId, 1), serializeMessages(parsed));
          this.writeIndex(sessionId, initial);
          return { messages: parsed, appended: true };
        }

        const existing = this.indexedMessages(sessionId, index);
        const matchedRows = parsed.map((message) => {
          const rows = existing.get(message.id) ?? [];
          if (rows.some((row) => comparableMessage(row) !== comparableMessage(message))) throw new Error(`Conversation message '${message.id}' conflicts with indexed canonical content.`);
          return rows[0];
        });
        if (matchedRows.every((row) => row !== undefined)) return { messages: matchedRows as AgentMessage[], appended: false };
        if (matchedRows.some((row) => row !== undefined)) throw new Error('Conversation appendBatch conflicts with a partially persisted batch.');

        const activePath = activeVersionPath(this.projectRoot, sessionId, index.active_version);
        if (!existsSync(activePath)) throw new Error(`Conversation active version '${index.active_version}' for '${sessionId}' was not found.`);
        const prior = readStrictConversationContent(activePath);
        this.replace(activePath, `${prior}${serializeMessages(parsed)}`);
        return { messages: parsed, appended: true };
      } catch (error) {
        if (error instanceof IndeterminatePublicationError) this.#failed = true;
        throw error;
      }
    });
    if (!result.applied) throw new Error('Conversation mutation authority is stale.');
    if (result.value.appended) {
      this.changes.conversationChanged(sessionId);
      this.changes.agentsChanged();
    }
    return result.value;
  }

  replaceActiveVersion(authority: MutationAuthority, args: ConversationCompactionCommit): { index: ConversationIndex; versionReplacement: ConversationVersionReplacement } {
    if (this.#failed) throw new Error('Conversation store has failed and requires restart.');
    const result = this.lane.apply(authority, 'conversation compaction commit', () => {
      const index = readValidatedConversationIndex(this.projectRoot, args.sessionId);
      if (!index) throw new Error(`Conversation '${args.sessionId}' does not exist.`);
      if (index.active_version !== args.sourceVersion) throw new Error(`Conversation '${args.sessionId}' active version changed from ${args.sourceVersion} to ${index.active_version} during compaction.`);
      const sourcePath = activeVersionPath(this.projectRoot, args.sessionId, args.sourceVersion);
      const sourceContent = readStrictConversationContent(sourcePath);
      if (conversationContentDigest(sourceContent) !== args.sourceDigest) throw new Error(`Conversation '${args.sessionId}' changed during compaction.`);
      const sourceEntry = index.versions[String(args.sourceVersion)];
      if (!sourceEntry || sourceEntry.status !== 'active') throw new Error(`Conversation '${args.sessionId}' source version ${args.sourceVersion} is not active.`);
      for (const line of args.content.split('\n').filter(Boolean)) agentMessageSchema.parse(JSON.parse(line));

      const nextVersion = Math.max(...Object.keys(index.versions).map(Number)) + 1;
      const frozenAt = new Date().toISOString();
      const nextIndex: ConversationIndex = {
        ...index,
        active_version: nextVersion,
        versions: {
          ...index.versions,
          [String(args.sourceVersion)]: { ...sourceEntry, status: 'frozen', frozen_at: frozenAt, size_bytes: statSync(sourcePath).size },
          [String(nextVersion)]: { status: 'active', opened_at: frozenAt, source_version: args.sourceVersion, compaction_generation: args.compactionGeneration, compacted_through: args.compactedThrough, summary_ids: args.summaryIds, bands: args.bands },
        },
      };
      try {
        this.replace(activeVersionPath(this.projectRoot, args.sessionId, nextVersion), args.content);
        this.writeIndex(args.sessionId, nextIndex);
      } catch (error) {
        if (error instanceof IndeterminatePublicationError) this.#failed = true;
        throw error;
      }
      return { index: nextIndex, versionReplacement: { sessionId: args.sessionId, activeVersion: nextVersion, compactedThrough: args.compactedThrough, compactionGeneration: args.compactionGeneration } };
    });
    if (!result.applied) throw new Error('Conversation mutation authority is stale.');
    this.changes.conversationChanged(args.sessionId);
    this.changes.agentsChanged();
    return result.value;
  }

  appendSummaryCacheEntry(authority: MutationAuthority, sessionId: string, entry: Omit<SummaryCacheEntry, 'created_at'> & { created_at?: string }): SummaryCacheEntry {
    const parsed = summaryCacheEntrySchema.parse({ ...entry, created_at: entry.created_at ?? new Date().toISOString() });
    const result = this.lane.apply(authority, 'conversation summary cache append', () => {
      const path = summaryCachePath(this.projectRoot, sessionId);
      const current = readSummaryCacheStrict(path);
      const existing = current.find((item) => item.cache_key === parsed.cache_key);
      if (existing) {
        if (canonicalSummary(existing) !== canonicalSummary(parsed)) throw new Error(`Summary cache entry '${parsed.cache_key}' already exists and is immutable.`);
        return existing;
      }
      try { this.replace(path, serializeSummaryCache([...current, parsed])); }
      catch (error) { if (error instanceof IndeterminatePublicationError) this.#failed = true; throw error; }
      return parsed;
    });
    if (!result.applied) throw new Error('Conversation mutation authority is stale.');
    return result.value;
  }

  private replace(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    durablyReplaceFile(path, Buffer.from(content));
  }

  private writeIndex(sessionId: string, index: ConversationIndex): void {
    if (index.session_id !== sessionId) throw new Error(`Conversation index session '${index.session_id}' does not match '${sessionId}'.`);
    const parsed = conversationIndexSchema.parse(index);
    this.replace(conversationIndexPath(this.projectRoot, sessionId), `${JSON.stringify(parsed, null, 2)}\n`);
  }

  private indexedMessages(sessionId: string, index: ConversationIndex): Map<string, AgentMessage[]> {
    const messages = new Map<string, AgentMessage[]>();
    for (const version of Object.keys(index.versions).map(Number).sort((a, b) => a - b)) {
      const path = activeVersionPath(this.projectRoot, sessionId, version);
      if (!existsSync(path)) throw new Error(`Conversation indexed version '${path}' was not found.`);
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
    const targets = new Set<string>(['index.json', 'summaries.jsonl']);
    for (const entry of readdirSync(directory)) {
      if (/^\d+\.jsonl$/.test(entry)) targets.add(entry);
      const match = /^\.(index\.json|summaries\.jsonl|\d+\.jsonl)\.saivage-write-[0-9a-f-]+\.tmp$/.exec(entry);
      if (match?.[1]) targets.add(match[1]);
    }
    cleanupDurableReplacementTemporaries(directory, [...targets]);
    const index = readValidatedConversationIndex(this.projectRoot, sessionId);
    if (!index) {
      if (existsSync(summaryCachePath(this.projectRoot, sessionId))) throw new Error(`Conversation '${sessionId}' has a summary cache without an index.`);
      for (const entry of readdirSync(directory)) if (/^\d+\.jsonl$/.test(entry)) unlinkSync(join(directory, entry));
      return;
    }
    const referenced = new Set(Object.keys(index.versions).map((version) => `${version}.jsonl`));
    for (const name of referenced) readConversationVersionMessages(join(directory, name));
    for (const entry of readdirSync(directory)) if (/^\d+\.jsonl$/.test(entry) && !referenced.has(entry)) unlinkSync(join(directory, entry));
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
