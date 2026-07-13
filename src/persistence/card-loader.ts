import { join } from 'node:path';
import { saivageCardsRoot } from './layout.js';

export function cardRecordsRoot(projectRoot: string): string { return saivageCardsRoot(projectRoot); }
export function cardRecordNamespaceDir(projectRoot: string, id: string): string { return join(cardRecordsRoot(projectRoot), id); }
