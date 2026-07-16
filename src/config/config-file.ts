import { readFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';

import { replaceFile, type PublicationTemporaryIdFactory } from '../persistence/replace-file.js';

export function readConfigYaml(selectedPath: string): unknown | null {
  let source: string;
  try { source = readFileSync(selectedPath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  return parse(source) as unknown;
}

export function replaceConfigYaml(selectedPath: string, validatedDocument: unknown, publicationTemporaryId?: PublicationTemporaryIdFactory): void {
  const source = typeof validatedDocument === 'object' && validatedDocument !== null && 'toJS' in validatedDocument
    ? String(validatedDocument)
    : stringify(validatedDocument);
  replaceFile(selectedPath, Buffer.from(source), publicationTemporaryId);
}
