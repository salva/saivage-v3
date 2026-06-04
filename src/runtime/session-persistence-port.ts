import { join } from 'node:path';
import type { AgentMessage, AgentSession } from '../schemas/index.js';
import type { RoundStamp, RuntimeAppendRecorder } from '../contracts/session-stamper.js';
import {
  appendActivateCardToolResultOnce,
  findPlannerSessionForCard,
  findUniqueUnresolvedActivateCardToolCall,
  getSession,
  getSessionMessages,
  listSessions,
} from './session-persistence.js';

export interface RuntimeSessionPersistencePort {
  findPlannerSessionForCard(parentCardId: string): Pick<AgentSession, 'id'> | null | undefined;
  findUniqueUnresolvedActivateCardToolCall(sessionId: string, childCardId: string): { tool_call_id: string } | null | undefined;
  appendActivateCardToolResultOnce(
    sessionId: string,
    toolCallId: string,
    content: string,
    stamp: RoundStamp,
    appendRecorder?: RuntimeAppendRecorder,
  ): AgentMessage;
  listSessions(): string[];
  getSession(sessionId: string): Pick<AgentSession, 'role'> | null;
  getSessionMessages(sessionId: string): AgentMessage[];
}

export function createFileRuntimeSessionPersistencePort(projectRoot: string): RuntimeSessionPersistencePort {
  const saivageDir = join(projectRoot, '.saivage');
  return {
    findPlannerSessionForCard: (parentCardId) => findPlannerSessionForCard(saivageDir, parentCardId),
    findUniqueUnresolvedActivateCardToolCall: (sessionId, childCardId) =>
      findUniqueUnresolvedActivateCardToolCall(saivageDir, sessionId, childCardId),
    appendActivateCardToolResultOnce: (sessionId, toolCallId, content, stamp, appendRecorder) =>
      appendActivateCardToolResultOnce(saivageDir, sessionId, toolCallId, content, stamp, appendRecorder),
    listSessions: () => listSessions(saivageDir),
    getSession: (sessionId) => getSession(saivageDir, sessionId),
    getSessionMessages: (sessionId) => getSessionMessages(saivageDir, sessionId),
  };
}
