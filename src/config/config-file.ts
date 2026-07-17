import { stringify } from 'yaml';
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { replaceFile, type PublicationTemporaryIdFactory } from '../persistence/replace-file.js';

export function replaceConfigYaml(selectedPath: string, validatedDocument: unknown, publicationTemporaryId?: PublicationTemporaryIdFactory): void {
  const source = typeof validatedDocument === 'object' && validatedDocument !== null && 'toJS' in validatedDocument
    ? String(validatedDocument)
    : stringify(validatedDocument);
  const owner = dirname(selectedPath);
  try { mkdirSync(owner); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const stat = lstatSync(owner); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Configuration owner '${owner}' must be a real directory.`); }
  replaceFile(selectedPath, Buffer.from(source), publicationTemporaryId);
}
