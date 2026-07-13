import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { appLogFile } from './layout.js';
import type { CompositionMutationAuthority, MutationAuthority } from '../application/mutation-authority.js';
import type { MutationLane } from '../application/mutation-lane.js';
import type { ReadModelChanges } from '../application/read-model-changes.js';
import { IndeterminatePublicationError } from './errors.js';

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

export class AppLogStore {
  #failed = false;

  constructor(readonly projectRoot: string, private readonly lane: MutationLane, private readonly changes?: ReadModelChanges) {}

  restabilize(authority: CompositionMutationAuthority): void {
    const result = this.lane.apply(authority, 'app log restabilization', () => restabilizeAppLog(this.projectRoot));
    if (!result.applied) throw new Error('Composition authority unexpectedly became stale.');
  }

  append(authority: MutationAuthority, entry: AppLogEntry): AppLogEntry {
    if (this.#failed) throw new Error('App log store has failed and requires restart.');
    const parsed = appLogEntrySchema.parse(entry);
    const result = this.lane.apply(authority, 'app log append', () => {
      const existing = readAppLogEntries(this.projectRoot).find((row) => row.id === parsed.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(parsed)) throw new Error(`App log entry '${parsed.id}' already exists with different content.`);
        return { entry: existing, appended: false };
      }
      try { appendDurably(appLogFile(this.projectRoot), `${JSON.stringify(parsed)}\n`); }
      catch (error) { this.#failed = true; throw new IndeterminatePublicationError(appLogFile(this.projectRoot), { cause: error }); }
      return { entry: parsed, appended: true };
    });
    if (!result.applied) throw new Error('App log mutation authority is stale.');
    if (result.value.appended) this.changes?.agentsChanged();
    return result.value.entry;
  }
}

export function readAppLogEntries(projectRoot: string, type?: AppLogEntryType): AppLogEntry[] {
  const path = appLogFile(projectRoot);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (!raw) return [];
  if (!raw.endsWith('\n')) throw new Error(`App log '${path}' has an incomplete final row.`);
  const entries: AppLogEntry[] = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const parsed = appLogEntrySchema.parse(JSON.parse(line));
      if (!type || parsed.type === type) entries.push(parsed);
    } catch (error) {
      throw new Error(`App log '${path}' is malformed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return entries;
}

function restabilizeAppLog(projectRoot: string): void {
  const path = appLogFile(projectRoot);
  if (!existsSync(path)) return;
  const content = readFileSync(path);
  if (content.length > 0 && content[content.length - 1] !== 0x0a) {
    const lastNewline = content.lastIndexOf(0x0a);
    truncateSync(path, lastNewline < 0 ? 0 : lastNewline + 1);
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  readAppLogEntries(projectRoot);
}

function appendDurably(path: string, content: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const fd = openSync(path, 'a');
  try {
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const directoryFd = openSync(directory, 'r');
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}
