import { stringify } from 'yaml';

import { replaceFile, type PublicationTemporaryIdFactory } from '../persistence/replace-file.js';

export function replaceConfigYaml(selectedPath: string, validatedDocument: unknown, publicationTemporaryId?: PublicationTemporaryIdFactory): void {
  const source = typeof validatedDocument === 'object' && validatedDocument !== null && 'toJS' in validatedDocument
    ? String(validatedDocument)
    : stringify(validatedDocument);
  replaceFile(selectedPath, Buffer.from(source), publicationTemporaryId);
}
