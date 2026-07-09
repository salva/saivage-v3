import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileSyncDurable } from '../../persistence/index.js';
import { cardIdFromSessionId } from './ids.js';

const conversationVersionFileNameSchema = z.string().regex(/^\d+\.jsonl$/);

export const conversationVersionEntrySchema = z.object({
  status: z.enum(['active', 'frozen']),
  opened_at: z.string(),
  frozen_at: z.string().optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  compacted_through: z.object({
    message_id: z.string(),
    round_id: z.string(),
    timestamp: z.string(),
  }).strict().optional(),
  source_version: z.number().int().positive().optional(),
  summary_ids: z.array(z.string()).optional(),
  compaction_generation: z.number().int().nonnegative().optional(),
  bands: z.object({
    merge_line: z.number(),
    summary_line: z.number(),
    trigger: z.number(),
    snap: z.enum(['keep_straddler_verbatim', 'compact_straddler']),
  }).strict().optional(),
}).strict();

export type ConversationVersionEntry = z.infer<typeof conversationVersionEntrySchema>;

export const conversationIndexSchema = z.object({
  schema_version: z.literal(2),
  session_id: z.string(),
  active_version: z.number().int().positive(),
  versions: z.record(z.string().regex(/^\d+$/), conversationVersionEntrySchema),
}).strict().superRefine((index, ctx) => {
  const activeKey = String(index.active_version);
  const activeEntry = index.versions[activeKey];
  if (!activeEntry) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `active version ${activeKey} is not listed` });
    return;
  }
  const activeEntries = Object.entries(index.versions).filter(([, entry]) => entry.status === 'active');
  if (activeEntries.length !== 1 || activeEntry.status !== 'active') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'index must contain exactly one active version matching active_version' });
  }
});

export type ConversationIndex = z.infer<typeof conversationIndexSchema>;

export function conversationDir(projectRoot: string, sessionId: string): string {
  const encodedSessionId = encodeURIComponent(sessionId);
  const cardId = cardIdFromSessionId(sessionId);
  if (cardId) return join(projectRoot, '.saivage', 'outputs', 'cards', cardId, 'conversations', encodedSessionId);
  return join(projectRoot, '.saivage', 'agents', 'conversations', encodedSessionId);
}

export function conversationIndexPath(projectRoot: string, sessionId: string): string {
  return join(conversationDir(projectRoot, sessionId), 'index.json');
}

export function activeVersionPath(projectRoot: string, sessionId: string, version: number): string {
  return join(conversationDir(projectRoot, sessionId), conversationVersionFileNameSchema.parse(`${version}.jsonl`));
}

export function versionExists(projectRoot: string, sessionId: string, version: number): boolean {
  return existsSync(activeVersionPath(projectRoot, sessionId, version));
}

export function writeConversationIndex(projectRoot: string, sessionId: string, index: ConversationIndex): void {
  if (index.session_id !== sessionId) throw new Error(`Conversation index session '${index.session_id}' does not match '${sessionId}'.`);
  const parsed = conversationIndexSchema.parse(index);
  writeFileSyncDurable(conversationIndexPath(projectRoot, sessionId), JSON.stringify(parsed, null, 2) + '\n');
}

export function writeConversationVersion(projectRoot: string, sessionId: string, version: number, content: string): void {
  mkdirSync(conversationDir(projectRoot, sessionId), { recursive: true });
  writeFileSyncDurable(activeVersionPath(projectRoot, sessionId, version), content);
}

export function writeCompactedConversationVersion(args: {
  projectRoot: string;
  sessionId: string;
  sourceVersion: number;
  content: string;
  compactedThrough: { message_id: string; round_id: string; timestamp: string };
  summaryIds: string[];
  compactionGeneration: number;
  bands: { merge_line: number; summary_line: number; trigger: number; snap: 'keep_straddler_verbatim' | 'compact_straddler' };
}): ConversationIndex {
  const index = ensureConversationIndex(args.projectRoot, args.sessionId);
  if (index.active_version !== args.sourceVersion) throw new Error(`Conversation '${args.sessionId}' active version changed from ${args.sourceVersion} to ${index.active_version} during compaction.`);
  const sourceEntry = index.versions[String(args.sourceVersion)];
  if (!sourceEntry || sourceEntry.status !== 'active') throw new Error(`Conversation '${args.sessionId}' source version ${args.sourceVersion} is not active.`);

  const nextVersion = Math.max(...Object.keys(index.versions).map(Number)) + 1;
  writeConversationVersion(args.projectRoot, args.sessionId, nextVersion, args.content);
  const frozenAt = new Date().toISOString();
  const sourceSize = statSync(activeVersionPath(args.projectRoot, args.sessionId, args.sourceVersion)).size;
  const nextIndex: ConversationIndex = {
    ...index,
    active_version: nextVersion,
    versions: {
      ...index.versions,
      [String(args.sourceVersion)]: {
        ...sourceEntry,
        status: 'frozen',
        frozen_at: frozenAt,
        size_bytes: sourceSize,
      },
      [String(nextVersion)]: {
        status: 'active',
        opened_at: frozenAt,
        source_version: args.sourceVersion,
        compaction_generation: args.compactionGeneration,
        compacted_through: args.compactedThrough,
        summary_ids: args.summaryIds,
        bands: args.bands,
      },
    },
  };
  writeConversationIndex(args.projectRoot, args.sessionId, nextIndex);
  return nextIndex;
}

export function readConversationIndex(projectRoot: string, sessionId: string): ConversationIndex | null {
  const path = conversationIndexPath(projectRoot, sessionId);
  if (!existsSync(path)) return null;
  const raw = readRawIndex(path);
  const index = parseV2Index(path, raw);
  if (index.session_id !== sessionId) throw new Error(`Conversation index '${path}' is for session '${index.session_id}', not '${sessionId}'.`);
  cleanupOrphanJsonl(projectRoot, sessionId, index);
  return index;
}

export function ensureConversationIndex(projectRoot: string, sessionId: string): ConversationIndex {
  const existing = readConversationIndex(projectRoot, sessionId);
  if (existing) return existing;
  mkdirSync(conversationDir(projectRoot, sessionId), { recursive: true });
  writeFileSyncDurable(activeVersionPath(projectRoot, sessionId, 1), '');
  const now = new Date().toISOString();
  const index: ConversationIndex = {
    schema_version: 2,
    session_id: sessionId,
    active_version: 1,
    versions: { '1': { status: 'active', opened_at: now } },
  };
  writeConversationIndex(projectRoot, sessionId, index);
  cleanupOrphanJsonl(projectRoot, sessionId, index);
  return index;
}

function readRawIndex(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`Conversation index '${path}' is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseV2Index(path: string, raw: unknown): ConversationIndex {
  try {
    return conversationIndexSchema.parse(raw);
  } catch (error) {
    throw new Error(`Conversation index '${path}' is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cleanupOrphanJsonl(projectRoot: string, sessionId: string, index: ConversationIndex): void {
  const dir = conversationDir(projectRoot, sessionId);
  const referenced = new Set(Object.keys(index.versions).map((version) => `${version}.jsonl`));
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === 'summaries.jsonl') continue;
    const isConversationJsonl = conversationVersionFileNameSchema.safeParse(entry.name).success;
    if (!isConversationJsonl || referenced.has(entry.name)) continue;
    unlinkSync(join(dir, entry.name));
  }
}
