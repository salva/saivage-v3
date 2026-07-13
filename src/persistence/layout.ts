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

export function saivageStateRoot(projectRoot: string): string {
  return join(saivageRoot(projectRoot), 'state');
}

export function saivageLogsRoot(projectRoot: string): string {
  return join(saivageRoot(projectRoot), 'logs');
}

export function saivageLocksRoot(projectRoot: string): string {
  return join(saivageRoot(projectRoot), 'locks');
}

export function runtimeStateFile(projectRoot: string): string {
  return join(saivageStateRoot(projectRoot), 'runtime.json');
}

export function deletedCardIdsFile(projectRoot: string): string {
  return join(saivageStateRoot(projectRoot), 'deleted-card-ids.json');
}

export function appLogFile(projectRoot: string): string {
  return join(saivageLogsRoot(projectRoot), 'app.jsonl');
}

export function runtimeProcessLockFile(projectRoot: string): string {
  return join(saivageLocksRoot(projectRoot), 'runtime.lock');
}

export function runtimeStateLockFile(projectRoot: string): string {
  return join(saivageLocksRoot(projectRoot), 'state.lock');
}

export function actorSnapshotsLockFile(projectRoot: string): string {
  return join(saivageLocksRoot(projectRoot), 'actor-snapshots.lock');
}

export function recoveryDiagnosticsFile(projectRoot: string): string {
  return join(saivageStateRoot(projectRoot), 'recovery-diagnostics.json');
}

export function recoveryDiagnosticsLockFile(projectRoot: string): string {
  return join(saivageLocksRoot(projectRoot), 'recovery-diagnostics.lock');
}

export function providerAvailabilityFile(projectRoot: string): string {
  return join(saivageStateRoot(projectRoot), 'provider-availability.jsonl');
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
