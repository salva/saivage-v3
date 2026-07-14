import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { z } from 'zod';

import type { ApplicationPersistenceHealth } from '../application/persistence-health.js';
import type { ReadModelChanges } from '../application/read-model-changes.js';
import { providerExchangeLogDataSchema, providerExchangeLogId } from '../contracts/provider-exchange-log.js';
import { contentReviewSchema, controlActionAuditEntrySchema, loggedEventSchema } from '../schemas/index.js';
import { cleanupDurableReplacementTemporaries } from './durable-file-replacement.js';
import { appendEnvelope, parseGrowingFile, publishFirstEnvelope, serializeGrowingEnvelope } from './growing-file.js';
import { appLogFile } from './layout.js';
import { discardIncompleteJsonlTail } from './store-restabilization.js';

export const errorRecordSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  kind: z.literal('error'),
  message: z.string(),
  cardId: z.string().optional(),
  goalId: z.string().optional(),
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

export class AppLogStore {
  readonly #entries: AppLogEntry[] = [];
  readonly #ids = new Set<string>();
  #loaded = false;
  #published = false;

  constructor(readonly projectRoot: string, private readonly health: ApplicationPersistenceHealth, private readonly changes?: ReadModelChanges) {}

  restabilize(): void {
    const path = appLogFile(this.projectRoot);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    cleanupDurableReplacementTemporaries(directory, [basename(path)]);
    if (existsSync(path)) discardIncompleteJsonlTail(path);
    const entries = readAppLogEntries(this.projectRoot);
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id)) throw new Error(`App log '${path}' contains duplicate id '${entry.id}'.`);
      ids.add(entry.id);
    }
    this.#entries.splice(0, this.#entries.length, ...entries);
    this.#ids.clear();
    for (const id of ids) this.#ids.add(id);
    this.#published = existsSync(path);
    this.#loaded = true;
  }

  entries(): readonly AppLogEntry[];
  entries<T extends AppLogEntryType>(type: T): readonly AppLogEntryOfType<T>[];
  entries(type?: AppLogEntryType): readonly AppLogEntry[] {
    if (!this.#loaded) throw new Error('App log has not been loaded.');
    return type === undefined ? [...this.#entries] : this.#entries.filter((entry) => entry.type === type);
  }

  append(entry: AppLogEntry): AppLogEntry {
    this.health.assertMutationHealthy();
    if (!this.#loaded) throw new Error('App log has not been loaded.');
    const parsed = appLogEntrySchema.parse(entry);
    if (this.#ids.has(parsed.id)) throw new Error(`App log entry '${parsed.id}' already exists.`);
    const path = appLogFile(this.projectRoot);
    const bytes = serializeGrowingEnvelope([parsed], appLogEntrySchema);
    if (this.#published) appendEnvelope(path, bytes, this.health, 'append app log entry');
    else publishFirstEnvelope(path, bytes, this.health, 'publish first app log envelope');
    this.#entries.push(parsed);
    this.#ids.add(parsed.id);
    this.#published = true;
    this.changes?.agentsChanged();
    return parsed;
  }
}

export function readAppLogEntries(projectRoot: string): AppLogEntry[];
export function readAppLogEntries<T extends AppLogEntryType>(projectRoot: string, type: T): AppLogEntryOfType<T>[];
export function readAppLogEntries(projectRoot: string, type?: AppLogEntryType): AppLogEntry[] {
  const path = appLogFile(projectRoot);
  if (!existsSync(path)) return [];
  const entries = parseGrowingFile(path, readFileSync(path, 'utf8'), appLogEntrySchema);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`App log '${path}' contains duplicate id '${entry.id}'.`);
    ids.add(entry.id);
  }
  return type === undefined ? entries : entries.filter((entry) => entry.type === type);
}
