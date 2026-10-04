import { dirname, join } from 'node:path';
import {
  cardIdSegments,
  recordHeadFilename,
  uuidV4Schema,
  type RecordName,
} from '../schemas/index.js';
import { conversationSessionIdentity, type ConversationSessionId } from '../schemas/index.js';

const SAIVAGE_RELATIVE_DIR = '.saivage';
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

export function cardChildrenRoot(projectRoot: string, cardId: string): string {
  return join(cardNamespace(projectRoot, cardId), 'children');
}
export function cardConversationsRoot(projectRoot: string, cardId: string): string {
  return join(cardNamespace(projectRoot, cardId), 'conversations');
}
export function cardConversationRoot(
  projectRoot: string,
  cardId: string,
  agentName: string,
): string {
  return join(cardConversationsRoot(projectRoot, cardId), agentName);
}
export function cardConversationVersionIndexFile(
  projectRoot: string,
  cardId: string,
  agentName: string,
): string {
  return join(cardConversationRoot(projectRoot, cardId, agentName), 'index.json');
}
export function cardConversationVersionsRoot(
  projectRoot: string,
  cardId: string,
  agentName: string,
): string {
  return join(cardConversationRoot(projectRoot, cardId, agentName), 'versions');
}
export function cardConversationVersionFile(
  projectRoot: string,
  cardId: string,
  agentName: string,
  filename: string,
): string {
  return join(cardConversationVersionsRoot(projectRoot, cardId, agentName), filename);
}

export function cardHeadFile(projectRoot: string, cardId: string): string {
  return join(cardNamespace(projectRoot, cardId), 'card-head.json');
}
export function cardPreviousHeadFile(projectRoot: string, cardId: string): string {
  return join(cardNamespace(projectRoot, cardId), 'card-head.prev.json');
}
export function conversationPreviousIndexFile(indexPath: string): string {
  return join(dirname(indexPath), 'index.prev.json');
}
export function cardHistoryRoot(projectRoot: string, cardId: string): string {
  return join(cardNamespace(projectRoot, cardId), 'card-history');
}
export function cardHistoryFile(projectRoot: string, cardId: string, entryId: string): string {
  return join(cardHistoryRoot(projectRoot, cardId), `${uuidV4Schema.parse(entryId)}.json`);
}
export function cardMailboxRoot(projectRoot: string, cardId: string): string {
  return join(cardNamespace(projectRoot, cardId), 'mailbox');
}
export function cardMailboxFile(
  projectRoot: string,
  cardId: string,
  notificationId: string,
): string {
  return join(cardMailboxRoot(projectRoot, cardId), `${uuidV4Schema.parse(notificationId)}.json`);
}
export function cardRecordsRoot(projectRoot: string, cardId: string): string {
  return join(cardNamespace(projectRoot, cardId), 'records');
}
export function cardAcceptedRecordsRoot(projectRoot: string, cardId: string): string {
  return join(cardRecordsRoot(projectRoot, cardId), 'accepted');
}
export function cardRecordHeadFile(
  projectRoot: string,
  cardId: string,
  definition: { readonly filename: RecordName },
): string {
  return join(cardRecordsRoot(projectRoot, cardId), recordHeadFilename(definition.filename));
}
export function cardRecordPreviousHeadFile(
  projectRoot: string,
  cardId: string,
  definition: { readonly filename: RecordName },
): string {
  return cardRecordHeadFile(projectRoot, cardId, definition).replace(/\.json$/, '.prev.json');
}
export function cardAcceptedRecordFile(
  projectRoot: string,
  cardId: string,
  entryId: string,
): string {
  return join(cardAcceptedRecordsRoot(projectRoot, cardId), `${uuidV4Schema.parse(entryId)}.json`);
}
export function globalAgentConversationRoot(projectRoot: string, agentName: string): string {
  return join(globalAgentConversationsRoot(projectRoot), agentName);
}
export function globalAgentConversationVersionIndexFile(
  projectRoot: string,
  agentName: string,
): string {
  return join(globalAgentConversationRoot(projectRoot, agentName), 'index.json');
}
export function globalAgentConversationVersionsRoot(
  projectRoot: string,
  agentName: string,
): string {
  return join(globalAgentConversationRoot(projectRoot, agentName), 'versions');
}
export function globalAgentConversationVersionFile(
  projectRoot: string,
  agentName: string,
  filename: string,
): string {
  return join(globalAgentConversationVersionsRoot(projectRoot, agentName), filename);
}

export function providerExchangeFile(
  projectRoot: string,
  sessionId: ConversationSessionId,
): string {
  const { agentName, cardId } = conversationSessionIdentity(sessionId);
  return join(
    cardId === null
      ? globalAgentConversationRoot(projectRoot, agentName)
      : cardConversationRoot(projectRoot, cardId, agentName),
    'provider-exchange.jsonl',
  );
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
