import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JsonlLedger } from './jsonl-ledger.js';
import { ProjectLock } from './project-lock.js';
import { appLogFile, appLogLockFile } from './layout.js';

export const appLogEntryTypeSchema = z.enum([
  'event',
  'error',
  'control_action',
  'provider_exchange',
  'content_review',
  'card_deleted',
]);

export const appLogEntrySchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  type: appLogEntryTypeSchema,
  data: z.unknown(),
});

export type AppLogEntry = z.infer<typeof appLogEntrySchema>;
export type AppLogEntryType = z.infer<typeof appLogEntryTypeSchema>;

export function appLogLedger(projectRoot: string): JsonlLedger<AppLogEntry> {
  return new JsonlLedger(appLogFile(projectRoot), appLogEntrySchema, new ProjectLock(appLogLockFile(projectRoot)), { version: null });
}

export function appendAppLogEntry(projectRoot: string, type: AppLogEntryType, data: unknown, timestamp = new Date().toISOString()): AppLogEntry {
  const entry: AppLogEntry = { id: randomUUID(), timestamp, type, data };
  const lock = new ProjectLock(appLogLockFile(projectRoot));
  const lockedLedger = new JsonlLedger(appLogFile(projectRoot), appLogEntrySchema, lock, { version: null });
  lock.withLockSync((handle) => lockedLedger.appendSync(handle, entry));
  return entry;
}

export function readAppLogEntries(projectRoot: string, type?: AppLogEntryType): AppLogEntry[] {
  const path = appLogFile(projectRoot);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return [];
  const entries: AppLogEntry[] = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const parsed = appLogEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success && (!type || parsed.data.type === type)) entries.push(parsed.data);
    } catch {
      // Ignore malformed app-log lines for read projections.
    }
  }
  return entries;
}
