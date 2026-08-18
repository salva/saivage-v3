import { join } from 'node:path';
import { cardIdSegments } from '../schemas/card-id.js';
import { recordStreamFilename, type RecordName } from '../schemas/record-name.js';

export const SAIVAGE_RELATIVE_DIR = '.saivage';
export const SAIVAGE_CARDS_RELATIVE_DIR = '.saivage/cards';
export const SAIVAGE_WORK_RELATIVE_DIR = '.saivage/work';

export function saivageRoot(projectRoot: string): string {
  return join(projectRoot, SAIVAGE_RELATIVE_DIR);
}

export function projectIdentityFile(projectRoot: string): string {
  return join(saivageRoot(projectRoot), 'project.json');
}

export function saivageAgentsRoot(projectRoot: string): string {
  return join(saivageRoot(projectRoot), 'agents');
}

export function globalAgentConversationsRoot(projectRoot: string): string {
  return join(saivageAgentsRoot(projectRoot), 'conversations');
}

export function saivageCardsRoot(projectRoot: string): string {
  return join(projectRoot, SAIVAGE_CARDS_RELATIVE_DIR);
}

export function cardNamespace(projectRoot: string, cardId: string): string {
  let path = join(saivageCardsRoot(projectRoot), 'project');
  for (const segment of cardIdSegments(cardId)) path = join(path, 'children', segment);
  return path;
}

export function cardChildrenRoot(projectRoot: string, cardId: string): string { return join(cardNamespace(projectRoot, cardId), 'children'); }
export function cardConversationsRoot(projectRoot: string, cardId: string): string { return join(cardNamespace(projectRoot, cardId), 'conversations'); }
export function cardConversationRoot(projectRoot: string, cardId: string, agentName: string): string { return join(cardConversationsRoot(projectRoot, cardId), agentName); }
export function cardConversationVersionIndexFile(projectRoot: string, cardId: string, agentName: string): string { return join(cardConversationRoot(projectRoot, cardId, agentName), 'index.json'); }
export function cardConversationVersionsRoot(projectRoot: string, cardId: string, agentName: string): string { return join(cardConversationRoot(projectRoot, cardId, agentName), 'versions'); }
export function cardConversationVersionFile(projectRoot: string, cardId: string, agentName: string, filename: string): string { return join(cardConversationVersionsRoot(projectRoot, cardId, agentName), filename); }

export function cardStreamFile(projectRoot: string, cardId: string): string { return join(cardNamespace(projectRoot, cardId), 'card.jsonl'); }
export function cardRecordStreamFile(projectRoot: string, cardId: string, definition: { readonly filename: RecordName }): string { return join(cardNamespace(projectRoot, cardId), recordStreamFilename(definition.filename)); }
export function globalAgentConversationRoot(projectRoot: string, agentName:string): string { return join(globalAgentConversationsRoot(projectRoot), agentName); }
export function globalAgentConversationVersionIndexFile(projectRoot: string, agentName:string): string { return join(globalAgentConversationRoot(projectRoot, agentName), 'index.json'); }
export function globalAgentConversationVersionsRoot(projectRoot: string, agentName:string): string { return join(globalAgentConversationRoot(projectRoot, agentName), 'versions'); }
export function globalAgentConversationVersionFile(projectRoot: string, agentName:string, filename:string): string { return join(globalAgentConversationVersionsRoot(projectRoot, agentName), filename); }

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

export function saivageWorkRelativePath(...segments: readonly string[]): string {
  return join(SAIVAGE_WORK_RELATIVE_DIR, ...segments);
}

export function cardTmpRelativePath(cardId: string, ...segments: readonly string[]): string {
  return saivageWorkRelativePath('cards', cardId, 'tmp', ...segments);
}

export function resetOwnedGeneratedRoots(projectRoot: string): readonly string[] {
  return [
    saivageCardsRoot(projectRoot),
    saivageAgentsRoot(projectRoot),
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
