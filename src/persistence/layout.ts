import { join } from 'node:path';

export const SAIVAGE_RELATIVE_DIR = '.saivage';
export const SAIVAGE_CARDS_RELATIVE_DIR = '.saivage/cards';
export const SAIVAGE_WORK_RELATIVE_DIR = '.saivage/work';

export function saivageRoot(projectRoot: string): string {
  return join(projectRoot, SAIVAGE_RELATIVE_DIR);
}

export function saivageCardsRoot(projectRoot: string): string {
  return join(projectRoot, SAIVAGE_CARDS_RELATIVE_DIR);
}

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
