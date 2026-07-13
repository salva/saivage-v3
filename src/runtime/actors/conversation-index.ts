import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { saivageCardsRoot } from '../../persistence/layout.js';
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
export type ConversationVersionReplacement = {
  sessionId: string;
  activeVersion: number;
  compactedThrough: { message_id: string; round_id: string; timestamp: string };
  compactionGeneration: number;
};

export function conversationDir(projectRoot: string, sessionId: string): string {
  const encodedSessionId = encodeURIComponent(sessionId);
  const cardId = cardIdFromSessionId(sessionId);
  if (cardId) return join(saivageCardsRoot(projectRoot), cardId, 'conversations', encodedSessionId);
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

export function readConversationIndex(projectRoot: string, sessionId: string): ConversationIndex | null {
  return readValidatedConversationIndex(projectRoot, sessionId);
}

export function readValidatedConversationIndex(projectRoot: string, sessionId: string): ConversationIndex | null {
  const path = conversationIndexPath(projectRoot, sessionId);
  if (!existsSync(path)) return null;
  const raw = readRawIndex(path);
  const index = parseV2Index(path, raw);
  if (index.session_id !== sessionId) throw new Error(`Conversation index '${path}' is for session '${index.session_id}', not '${sessionId}'.`);
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
