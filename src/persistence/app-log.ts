import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  appLogEntryLogicalId,
  appLogEntrySchema,
  type AppLogEntry,
  type AppLogEntryOfType,
  type AppLogEntryType,
} from '../contracts/app-log.js';
import { appendEnvelope, prepareGrowingEnvelope, publishFirstEnvelope, readCanonicalGrowingFile } from './growing-file.js';
import { appLogFile } from './layout.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';

export interface AppLogPublicationContext {
  readonly operationError?: unknown;
  readonly publicationTemporaryId?: PublicationTemporaryIdFactory;
}

export class AppLogPublicationError extends Error {
  readonly entryType: AppLogEntryType;
  readonly publicationCause: unknown;
  readonly operationError?: unknown;

  constructor(entryType: AppLogEntryType, publicationCause: unknown, operationError?: unknown) {
    super(`Required '${entryType}' app-log publication failed.`, { cause: publicationCause });
    this.name = 'AppLogPublicationError';
    this.entryType = entryType;
    this.publicationCause = publicationCause;
    if (operationError !== undefined) this.operationError = operationError;
  }
}

export function rethrowAppLogPublicationError(error: unknown): void {
  if (error instanceof AppLogPublicationError) throw error;
}

export function readAppLogEntries(projectRoot: string): AppLogEntry[];
export function readAppLogEntries<T extends AppLogEntryType>(projectRoot: string, type: T): AppLogEntryOfType<T>[];
export function readAppLogEntries(projectRoot: string, type?: AppLogEntryType): AppLogEntry[] {
  const path = appLogFile(projectRoot);
  let entries: AppLogEntry[];
  try { entries = readCanonicalGrowingFile(path, appLogEntrySchema); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = appLogEntryLogicalId(entry);
    if (ids.has(id)) throw new Error(`App log '${path}' contains duplicate logical id '${id}'.`);
    ids.add(id);
  }
  return type === undefined ? entries : entries.filter((entry) => entry.type === type);
}

export function appendAppLogEntry<T extends AppLogEntryType>(
  projectRoot: string,
  entryType: T,
  prepareEntry: () => AppLogEntryOfType<T>,
  context: AppLogPublicationContext = {},
): AppLogEntryOfType<T> {
  try {
    const candidate: AppLogEntry = prepareEntry();
    if (candidate.type !== entryType) throw new Error(`App-log preparation returned '${candidate.type}' for '${entryType}'.`);
    const prepared = prepareGrowingEnvelope([candidate], appLogEntrySchema);
    const parsed = prepared.rows[0] as AppLogEntryOfType<T>;
    const path = appLogFile(projectRoot);
    const result = appendEnvelope(path, prepared.bytes);
    switch (result.kind) {
      case 'appended': return parsed;
      case 'missing':
        for (const owner of [join(projectRoot, '.saivage'), join(projectRoot, '.saivage', 'logs')]) {
          try { mkdirSync(owner); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const stat = lstatSync(owner);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`App-log owner '${owner}' must be a real directory.`);
          }
        }
        publishFirstEnvelope(path, prepared.bytes, context.publicationTemporaryId);
        return parsed;
    }
  } catch (error) {
    if (error instanceof AppLogPublicationError) throw error;
    throw new AppLogPublicationError(entryType, error, context.operationError);
  }
}
