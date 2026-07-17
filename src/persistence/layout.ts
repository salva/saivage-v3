import { join } from 'node:path';
import { cardIdSegments } from '../schemas/card-id.js';

export const SAIVAGE_RELATIVE_DIR = '.saivage';
export const SAIVAGE_CARDS_RELATIVE_DIR = '.saivage/cards';
export const SAIVAGE_WORK_RELATIVE_DIR = '.saivage/work';

export function saivageRoot(projectRoot: string): string {
  return join(projectRoot, SAIVAGE_RELATIVE_DIR);
}

export function saivageCardsRoot(projectRoot: string): string {
  return join(projectRoot, SAIVAGE_CARDS_RELATIVE_DIR);
}

export function cardNamespace(projectRoot: string, cardId: string): string {
  let path = join(saivageCardsRoot(projectRoot), 'project');
  for (const segment of cardIdSegments(cardId)) path = join(path, 'children', segment);
  return path;
}

export function cardStreamFile(projectRoot: string, cardId: string): string { return join(cardNamespace(projectRoot, cardId), 'card.jsonl'); }
export function cardRecordStreamFile(projectRoot: string, cardId: string, slot: 'brief' | 'status' | 'review'): string { return join(cardNamespace(projectRoot, cardId), `${slot}.jsonl`); }
export function cardConversationFile(projectRoot: string, cardId: string, role: 'planner' | 'executor' | 'reviewer'): string { return join(cardNamespace(projectRoot, cardId), 'conversations', `${role}.jsonl`); }
export function analystConversationFile(projectRoot: string): string { return join(saivageRoot(projectRoot), 'agents', 'conversations', 'analyst%3Aglobal.jsonl'); }

export function saivageLogsRoot(projectRoot: string): string {
  return join(saivageRoot(projectRoot), 'logs');
}

export function saivageLocksRoot(projectRoot: string): string {
  return join(saivageRoot(projectRoot), 'locks');
}

export function appLogFile(projectRoot: string): string {
  return join(saivageLogsRoot(projectRoot), 'app.jsonl');
}

export function runtimeProcessLockFile(projectRoot: string): string {
  return join(saivageLocksRoot(projectRoot), 'runtime.lock');
}

export function saivageWorkRoot(projectRoot: string): string {
  return join(projectRoot, SAIVAGE_WORK_RELATIVE_DIR);
}

export function resetOwnedGeneratedRoots(projectRoot: string): readonly string[] {
  return [
    saivageCardsRoot(projectRoot),
    join(saivageRoot(projectRoot), 'agents'),
    saivageLogsRoot(projectRoot),
    saivageWorkRoot(projectRoot),
  ];
}

export function cardWorkRoot(projectRoot: string, cardId: string): string {
  return join(saivageWorkRoot(projectRoot), 'cards', cardId);
}

export function cardProcessOutputRoot(projectRoot: string, cardId: string, procId: string): string {
  return join(cardWorkRoot(projectRoot, cardId), 'processes', procId);
}

export function nonCardProcessOutputRoot(projectRoot: string, procId: string): string {
  return join(saivageWorkRoot(projectRoot), 'processes', procId);
}
