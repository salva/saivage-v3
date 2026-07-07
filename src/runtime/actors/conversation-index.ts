import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileSyncDurable } from '../../persistence/index.js';

const v1ConversationSegmentNameSchema = z.string().regex(/^seg-\d{3}\.jsonl$/);
const conversationVersionFileNameSchema = z.string().regex(/^\d+\.jsonl$/);

const v1ConversationIndexSchema = z.object({
  schema_version: z.literal(1),
  active_segment: v1ConversationSegmentNameSchema,
}).strict();

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
  return join(projectRoot, '.saivage', 'agents', 'conversations', encodeURIComponent(sessionId));
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

export function readConversationIndex(projectRoot: string, sessionId: string): ConversationIndex | null {
  const path = conversationIndexPath(projectRoot, sessionId);
  if (!existsSync(path)) return null;
  const raw = readRawIndex(path);
  if (raw && typeof raw === 'object' && 'schema_version' in raw && raw.schema_version === 1) {
    return migrateV1Index(projectRoot, sessionId, raw);
  }
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

function migrateV1Index(projectRoot: string, sessionId: string, raw: unknown): ConversationIndex {
  const path = conversationIndexPath(projectRoot, sessionId);
  let v1Index: z.infer<typeof v1ConversationIndexSchema>;
  try {
    v1Index = v1ConversationIndexSchema.parse(raw);
  } catch (error) {
    throw new Error(`Conversation index '${path}' cannot be migrated: ${error instanceof Error ? error.message : String(error)}`);
  }

  const sourcePath = join(conversationDir(projectRoot, sessionId), v1Index.active_segment);
  if (!existsSync(sourcePath)) throw new Error(`Conversation v1 active segment '${v1Index.active_segment}' for '${sessionId}' was not found.`);

  const content = readFileSync(sourcePath, 'utf-8');
  writeFileSyncDurable(activeVersionPath(projectRoot, sessionId, 1), content);

  const sourceStat = statSync(sourcePath);
  const openedAt = sourceStat.birthtimeMs > 0 ? sourceStat.birthtime.toISOString() : sourceStat.mtime.toISOString();
  const index: ConversationIndex = {
    schema_version: 2,
    session_id: sessionId,
    active_version: 1,
    versions: { '1': { status: 'active', opened_at: openedAt, compaction_generation: 0, size_bytes: sourceStat.size } },
  };
  writeConversationIndex(projectRoot, sessionId, index);
  unlinkSync(sourcePath);
  cleanupOrphanJsonl(projectRoot, sessionId, index);
  return index;
}

function cleanupOrphanJsonl(projectRoot: string, sessionId: string, index: ConversationIndex): void {
  const dir = conversationDir(projectRoot, sessionId);
  const referenced = new Set(Object.keys(index.versions).map((version) => `${version}.jsonl`));
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === 'summaries.jsonl') continue;
    const isConversationJsonl = conversationVersionFileNameSchema.safeParse(entry.name).success || v1ConversationSegmentNameSchema.safeParse(entry.name).success;
    if (!isConversationJsonl || referenced.has(entry.name)) continue;
    unlinkSync(join(dir, entry.name));
  }
}
