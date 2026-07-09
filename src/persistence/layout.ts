import { join } from 'node:path';

export const SAIVAGE_CARDS_RELATIVE_DIR = '.saivage/cards';
export const SAIVAGE_WORK_RELATIVE_DIR = '.saivage/work';

export function saivageCardsRoot(projectRoot: string): string {
  return join(projectRoot, SAIVAGE_CARDS_RELATIVE_DIR);
}

export function saivageWorkRoot(projectRoot: string): string {
  return join(projectRoot, SAIVAGE_WORK_RELATIVE_DIR);
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
