import { mkdirSync } from 'node:fs';

import {
  appLogEntryLogicalId,
  appLogEntrySchema,
  type AppLogEntry,
  type AppLogEntryOfType,
  type AppLogEntryType,
} from '../contracts/index.js';
import {
  admitGrowingFileTail,
  appendEnvelope,
  serializeGrowingEnvelope,
  publishFirstEnvelope,
  readCanonicalBytesOrMissing,
  consumeGrowingRows,
} from './growing-file.js';
import { appLogFile, saivageLogsRoot, saivageRoot } from './layout.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';

export interface AppLogPublicationContext {
  readonly publicationTemporaryId?: PublicationTemporaryIdFactory;
}

function validateAppLogEntries(path: string, entries: readonly AppLogEntry[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = appLogEntryLogicalId(entry);
    if (ids.has(id)) throw new Error(`App log '${path}' contains duplicate logical id '${id}'.`);
    ids.add(id);
  }
}

export function readAppLogEntries(projectRoot: string): AppLogEntry[];
export function readAppLogEntries<T extends AppLogEntryType>(
  projectRoot: string,
  type: T,
): AppLogEntryOfType<T>[];
export function readAppLogEntries(projectRoot: string, type?: AppLogEntryType): AppLogEntry[] {
  const path = appLogFile(projectRoot);
  const bytes = readCanonicalBytesOrMissing(path);
  if (bytes === null) return [];
  const entries = consumeGrowingRows(path, bytes, appLogEntrySchema, (rows) => {
    validateAppLogEntries(path, rows);
    return rows;
  });
  return type === undefined ? entries : entries.filter((entry) => entry.type === type);
}

export function initializeAppLog(projectRoot: string): void {
  readAppLogEntries(projectRoot);
}

export function appendAppLogEntry<T extends AppLogEntryType>(
  projectRoot: string,
  entryType: T,
  prepareEntry: () => AppLogEntryOfType<T>,
  context: AppLogPublicationContext = {},
): AppLogEntryOfType<T> {
  const candidate = prepareEntry();
  if (candidate.type !== entryType)
    throw new Error(`App-log preparation returned '${candidate.type}' for '${entryType}'.`);
  appLogEntrySchema.parse(candidate);
  const bytes = serializeGrowingEnvelope([candidate]);
  const path = appLogFile(projectRoot);
  admitGrowingFileTail(path, appLogEntrySchema, (rows) => validateAppLogEntries(path, rows));
  const result = appendEnvelope(path, bytes);
  switch (result.kind) {
    case 'appended':
      return candidate;
    case 'missing':
      // App log may be the first log writer and owns these exact directory creations/admissions.
      for (const owner of [saivageRoot(projectRoot), saivageLogsRoot(projectRoot)]) {
        try {
          mkdirSync(owner);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      publishFirstEnvelope(path, bytes, context.publicationTemporaryId);
      return candidate;
  }
}
