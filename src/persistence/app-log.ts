import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { join } from 'node:path';
import { cardIdSchema } from '../schemas/card-id.js';

import type { ReadModelChanges } from '../application/read-model-changes.js';
import { providerExchangeLogDataSchema, providerExchangeLogId } from '../contracts/provider-exchange-log.js';
import { contentReviewSchema, controlActionAuditEntrySchema, loggedEventSchema } from '../schemas/index.js';
import { appendEnvelope, publishFirstEnvelope, readCanonicalGrowingFile, serializeGrowingEnvelope } from './growing-file.js';
import { appLogFile } from './layout.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';

export const errorRecordSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  kind: z.literal('error'),
  message: z.string(),
  cardId: cardIdSchema.optional(),
  goalId: cardIdSchema.optional(),
  phase: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type ErrorRecord = z.infer<typeof errorRecordSchema>;
export type ErrorInput = Omit<ErrorRecord, 'kind' | 'id' | 'timestamp'> & { id?: string; timestamp?: string };

const eventEntrySchema = z.object({ id: z.string().min(1), timestamp: z.string().datetime(), type: z.literal('event'), data: loggedEventSchema }).strict();
const errorEntrySchema = z.object({ id: z.string().min(1), timestamp: z.string().datetime(), type: z.literal('error'), data: errorRecordSchema }).strict();
const controlEntrySchema = z.object({ id: z.string().min(1), timestamp: z.string().datetime(), type: z.literal('control_action'), data: controlActionAuditEntrySchema }).strict();
const providerEntrySchema = z.object({ id: z.string().min(1), timestamp: z.string().datetime(), type: z.literal('provider_exchange'), data: providerExchangeLogDataSchema }).strict();
const contentEntrySchema = z.object({ id: z.string().min(1), timestamp: z.string().datetime(), type: z.literal('content_review'), data: contentReviewSchema }).strict();

export const appLogEntrySchema = z.discriminatedUnion('type', [
  eventEntrySchema,
  errorEntrySchema,
  controlEntrySchema,
  providerEntrySchema,
  contentEntrySchema,
]).superRefine((entry, ctx) => {
  const authoritativeId = entry.type === 'provider_exchange' ? providerExchangeLogId(entry.data) : entry.data.id;
  const authoritativeTime = entry.type === 'control_action' || entry.type === 'content_review' ? entry.data.created_at : entry.data.timestamp;
  if (entry.id !== authoritativeId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: 'Outer app-log id must equal the payload identity.' });
  if (entry.timestamp !== authoritativeTime) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['timestamp'], message: 'Outer app-log timestamp must equal the payload timestamp.' });
});

export type AppLogEntry = z.infer<typeof appLogEntrySchema>;
export type AppLogEntryType = AppLogEntry['type'];
export type AppLogEntryOfType<T extends AppLogEntryType> = Extract<AppLogEntry, { type: T }>;
export interface AppLogContext { readonly projectRoot: string; readonly changes?: ReadModelChanges }

export function readAppLogEntries(projectRoot: string): AppLogEntry[];
export function readAppLogEntries<T extends AppLogEntryType>(projectRoot: string, type: T): AppLogEntryOfType<T>[];
export function readAppLogEntries(projectRoot: string, type?: AppLogEntryType): AppLogEntry[] {
  const path = appLogFile(projectRoot);
  let entries: AppLogEntry[];
  try { entries = readCanonicalGrowingFile(path, appLogEntrySchema); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`App log '${path}' contains duplicate id '${entry.id}'.`);
    ids.add(entry.id);
  }
  return type === undefined ? entries : entries.filter((entry) => entry.type === type);
}

export function appendAppLogEntry(projectRoot: string, entry: AppLogEntry, changes?: ReadModelChanges, publicationTemporaryId?: PublicationTemporaryIdFactory): AppLogEntry {
  const parsed = appLogEntrySchema.parse(entry);
  const entries = readAppLogEntries(projectRoot);
  if (entries.some((candidate) => candidate.id === parsed.id)) throw new Error(`App log entry '${parsed.id}' already exists.`);
  const path = appLogFile(projectRoot);
  const bytes = serializeGrowingEnvelope([parsed], appLogEntrySchema);
  if (entries.length === 0) {
    try {
      readFileSync(path);
      appendEnvelope(path, bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      for (const owner of [join(projectRoot, '.saivage'), join(projectRoot, '.saivage', 'logs')]) {
        try { mkdirSync(owner); }
        catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
          const stat = lstatSync(owner);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`App-log owner '${owner}' must be a real directory.`);
        }
      }
      publishFirstEnvelope(path, bytes, publicationTemporaryId);
    }
  } else appendEnvelope(path, bytes);
  changes?.agentsChanged();
  return parsed;
}
