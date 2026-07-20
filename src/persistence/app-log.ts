import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appLogEntrySchema, type AppLogEntry, type AppLogEntryOfType, type AppLogEntryType } from '../contracts/app-log.js';
import { appendEnvelope, publishFirstEnvelope, readCanonicalGrowingFile, serializeGrowingEnvelope } from './growing-file.js';
import { appLogFile } from './layout.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';

export interface AppLogContext { readonly projectRoot: string }

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

export function appendAppLogEntry(projectRoot: string, entry: AppLogEntry, publicationTemporaryId?: PublicationTemporaryIdFactory): AppLogEntry {
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
  return parsed;
}
